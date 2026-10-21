-- Why does Zenventory API 2.0 return 401 for clients that HAVE a key on file?
--
-- Measured 2026-10-14. The monitor reports 2 clients failing with
--   HTTP 401: {"message":"Invalid API key and/or secret","parameter":""}
-- and the client page shows the red "connection failed" banner on a card that
-- also shows an "API Key (2.0)" row -- which ZenventoryCredentials.tsx only
-- renders when the `apiKey` prop is truthy. So the stored key is NOT ''.
-- That rules out the empty-string theory (editable-fields.ts:103-114): a ''
-- key would render "No API 2.0 credentials" and no Test button at all.
--
-- The remaining shape-level explanations are all visible WITHOUT reading a key
-- value, which is what this file does. Nothing below selects a credential.
-- `length`, `btrim`, character-class predicates and a truncated md5 only. Do
-- not edit this file to print the values -- paste the OUTPUT back, and the
-- output is safe to paste.
--
-- A credential that fails every scheduled run forever is the failure mode
-- here: syncClientAssignments selects on `.not(zenventory_api_key,'is',null)`
-- (src/lib/sync/zenventory.ts:18-19), so a key that is present-but-wrong keeps
-- being retried six times a day and keeps 401-ing.

-- ---------------------------------------------------------------------------
-- QUERY 1 -- the shape of every active client's API 2.0 credential.
--
-- Read these columns in this order:
--
--   key_state / secret_state
--     'null'        not on file. Correctly skipped by the sync.
--     'empty'       '' -- on file as far as the sync filter is concerned,
--                   and it will authenticate with it forever. Clear to NULL.
--     'whitespace'  only spaces/tabs. Same trap as 'empty'.
--     'padded'      REAL VALUE, but with leading or trailing whitespace. This
--                   is the top suspect: saved before clean() trimmed, and
--                   axios puts it straight into the Basic Auth header, where
--                   a trailing space is part of the credential.
--     'ok'          no padding. The value itself is wrong -- rotated, revoked,
--                   belongs to another Zenventory account, or swapped with the
--                   secret.
--
--   key_len / secret_len
--     Compare the FAILING clients against the WORKING ones. Zenventory issues
--     fixed-shape credentials; a length that is an outlier by a character or
--     two usually means a copy-paste that clipped or doubled a character, and
--     a key_len that matches the others' secret_len means they are swapped.
--
--   key_charset / secret_charset
--     'alnum' or a named offender. A credential containing a newline or a
--     non-ASCII character came through a rich-text paste (a smart quote, a
--     non-breaking space) and will never authenticate.
--
--   key_fp / secret_fp
--     First 8 hex of md5. NOT reversible to the credential, and present for
--     exactly one purpose: spotting that two clients share one credential, or
--     that key_fp on one row equals secret_fp on the same row. Both of those
--     are invisible in every other column.
-- ---------------------------------------------------------------------------
select
  c.name,
  c.active,

  case
    when c.zenventory_api_key is null                      then 'null'
    when c.zenventory_api_key = ''                         then 'empty'
    when btrim(c.zenventory_api_key) = ''                  then 'whitespace'
    when c.zenventory_api_key <> btrim(c.zenventory_api_key) then 'padded'
    else 'ok'
  end as key_state,
  length(c.zenventory_api_key)         as key_len,
  length(btrim(c.zenventory_api_key))  as key_len_trimmed,
  case
    when c.zenventory_api_key is null then null
    when c.zenventory_api_key ~ '[\n\r]'      then 'HAS NEWLINE'
    when c.zenventory_api_key ~ '[^\x20-\x7e]' then 'HAS NON-ASCII'
    when c.zenventory_api_key ~ '\s'           then 'has inner whitespace'
    when c.zenventory_api_key ~ '^[A-Za-z0-9]+$' then 'alnum'
    else 'has punctuation'
  end as key_charset,
  left(md5(c.zenventory_api_key), 8)   as key_fp,

  case
    when c.zenventory_api_secret is null                         then 'null'
    when c.zenventory_api_secret = ''                            then 'empty'
    when btrim(c.zenventory_api_secret) = ''                     then 'whitespace'
    when c.zenventory_api_secret <> btrim(c.zenventory_api_secret) then 'padded'
    else 'ok'
  end as secret_state,
  length(c.zenventory_api_secret)        as secret_len,
  length(btrim(c.zenventory_api_secret)) as secret_len_trimmed,
  case
    when c.zenventory_api_secret is null then null
    when c.zenventory_api_secret ~ '[\n\r]'        then 'HAS NEWLINE'
    when c.zenventory_api_secret ~ '[^\x20-\x7e]'  then 'HAS NON-ASCII'
    when c.zenventory_api_secret ~ '\s'             then 'has inner whitespace'
    when c.zenventory_api_secret ~ '^[A-Za-z0-9]+$' then 'alnum'
    else 'has punctuation'
  end as secret_charset,
  left(md5(c.zenventory_api_secret), 8)  as secret_fp,

  -- The SecureKey is a different credential on a different API and is NOT
  -- what 401s here. Included only so a client missing it is not mistaken for
  -- a client with a bad 2.0 key.
  case
    when c.zenventory_secure_key is null      then 'null'
    when btrim(c.zenventory_secure_key) = ''  then 'blank'
    else 'present'
  end as securekey_state,

  -- Is this client in the scheduled sync? This is the sync's own filter,
  -- restated. A row that says `true` with key_state 'empty' is the
  -- fails-forever case.
  (c.active
    and c.zenventory_api_key is not null
    and c.zenventory_api_secret is not null) as in_scheduled_sync

from clients c
where c.active = true
order by
  -- Anything not 'ok' first, then the clients the monitor named.
  (case
    when c.zenventory_api_key is null then 1
    when btrim(c.zenventory_api_key) = '' then 0
    when c.zenventory_api_key <> btrim(c.zenventory_api_key) then 0
    else 2
   end),
  c.name;


-- ---------------------------------------------------------------------------
-- QUERY 2 -- is one credential shared, or is key/secret swapped?
--
-- Returns NOTHING in the healthy case. Any row is a finding:
--   'shared key'      two clients authenticate as the same Zenventory account.
--                     Whichever account the key belongs to, the other client's
--                     orders are being read from the wrong warehouse -- or
--                     401ing because that account was closed.
--   'key = secret'    the same string in both fields. Guaranteed 401.
-- ---------------------------------------------------------------------------
select 'shared key' as finding,
       left(md5(a.zenventory_api_key), 8) as fp,
       a.name as client_a, b.name as client_b
from clients a
join clients b
  on b.zenventory_api_key = a.zenventory_api_key
 and b.id > a.id
where a.active = true and b.active = true
  and btrim(coalesce(a.zenventory_api_key, '')) <> ''

union all

select 'key = secret' as finding,
       left(md5(c.zenventory_api_key), 8) as fp,
       c.name as client_a, null as client_b
from clients c
where c.active = true
  and c.zenventory_api_key = c.zenventory_api_secret
  and btrim(coalesce(c.zenventory_api_key, '')) <> '';

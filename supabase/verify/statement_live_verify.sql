-- Does /statements print the truth? Read-only.
--
-- Every static gate on the statement feature passes -- tsc, eslint, 1521 tests,
-- `next build` -- and not one of them touches the database. What they cannot
-- prove is the two things that actually decide whether a client gets invoiced
-- correctly:
--
--   1. that the select in statement-charges.ts names columns the LIVE
--      order_charges has. The phantom-column guard only proves each name
--      appears in SOME .sql file in this repo; it cannot prove the file ran.
--      `manual_total` and `new_cost` are the precedent -- three mutually
--      consistent wrong names that killed /billing and /reports outright.
--   2. that buildStatement's grouped sum equals the figure the ledger holds.
--
-- So this file recomputes the statement IN SQL, by the same rules the TypeScript
-- uses, and prints it in the shape the screen will. Two independent
-- implementations of one figure is normally the defect; here it is the
-- instrument, because the only way to catch a wrong sum is to compute it twice
-- from different code and compare.
--
-- HOW TO USE IT. Paste into a NEW QUERY tab (the editor runs the whole buffer
-- and shows only the last result, so this file is deliberately ONE statement),
-- run it, then open /statements and compare. A row here that does not match the
-- screen is a defect in one of the two, and the point is that neither is
-- trusted over the other until they agree.
--
-- WHAT IT DOES NOT TOUCH. select only -- no insert, update, delete, no DDL.
--
-- THE RULES IT MIRRORS, and where each lives in the code:
--
--   today        = the warehouse's date, not UTC's and not the server's.
--                  statement.ts:52 -> warehouseParts -> America/New_York.
--                  Between warehouse midnight and UTC midnight these differ,
--                  and 'today' would ask for a date the ledger is not yet
--                  writing to.
--   week         = Monday..Sunday. statement.ts, `(dow + 6) % 7`. Here
--                  isodow - 1, which agrees: Sunday is dow 0 -> back 6, and
--                  isodow 7 -> back 6.
--   period       = CALENDAR period containing today, inclusive both ends, never
--                  a trailing 30 days.
--   date column  = charge_date, the day the WORK happened. NOT calculated_at,
--                  or a backfill run today would move last month's picks into
--                  this month's statement.
--   grouping     = (charge_type, label). The label carries the rate-card
--                  variant, so 'Pick - single' and 'Pick - multi' are separate
--                  lines.
--   amount       = summed over the rows that HAVE one, with the count of rows
--                  left out reported beside it. sumPriced, unpriced.ts:233.
--   UNKNOWN      = printed only when EVERY counted row is unpriced
--                  (totalOrUnknown, unpriced.ts:186). A PARTIAL sum prints its
--                  total with the withheld count beside it -- two of five rows
--                  priced is a real figure about those two. Getting this
--                  backwards is the easy mistake and it is why the
--                  `unpriced = counted` test below is written out rather than
--                  `unpriced > 0`.
--   quantity     = summed over rows that have one; null only when none do. A
--                  peak surcharge is a percentage of a basis and carries no
--                  quantity, and rendering that as 0 units would state that
--                  nothing was handled beside a charge for handling it.
--   rates        = COUNT DISTINCT unit_rate. 0 -> 'at cost'; 1 -> the rate;
--                  2+ -> 'N rates', because a rate card edited mid-period
--                  prices Monday at one rate and Friday at another and both
--                  land on one line. Never averaged.
--
-- READ THESE THREE THINGS FIRST, before any individual figure:
--
--   * the TODAY line. If the date is not the warehouse's today, every period
--     below is the wrong period and nothing else here means anything.
--   * the COLUMNS line. It selects all seven columns the app selects. If this
--     query runs at all, the live table has them -- which is check (1) above,
--     and a 42703 here is the /billing outage reproduced before any client
--     sees it.
--   * any line reading TOTAL UNKNOWN. That is a period in which not one charge
--     could be priced, and the screen will say so rather than print $0.00.

with today as (
  select (now() at time zone 'America/New_York')::date as d
),
periods as (
  select 'day' as grain, 1 as ord, d as lo, d as hi from today
  union all
  select 'week', 2,
         d - (extract(isodow from d)::int - 1),
         d - (extract(isodow from d)::int - 1) + 6
    from today
  union all
  select 'month', 3,
         date_trunc('month', d)::date,
         (date_trunc('month', d) + interval '1 month' - interval '1 day')::date
    from today
  union all
  -- The CALENDAR half containing d: Jan..Jun or Jul..Dec, never a trailing six
  -- months. `(extract(month) - 1) / 6` is INTEGER division in Postgres, so
  -- months 1-6 give 0 and months 7-12 give 1 -- that many six-month steps on
  -- from the start of the year.
  select 'half-year', 4,
         (date_trunc('year', d)
            + ((extract(month from d)::int - 1) / 6) * interval '6 months')::date,
         (date_trunc('year', d)
            + ((extract(month from d)::int - 1) / 6) * interval '6 months'
            + interval '6 months' - interval '1 day')::date
    from today
  union all
  select 'year', 5,
         date_trunc('year', d)::date,
         (date_trunc('year', d) + interval '1 year' - interval '1 day')::date
    from today
),
-- Every (client, grain, charge_type, label) line, computed the way
-- buildStatement computes it.
lines as (
  select c.id                                            as client_id,
         c.name                                           as client_name,
         c.active                                         as client_active,
         p.grain,
         p.ord,
         p.lo,
         p.hi,
         oc.charge_type,
         oc.label,
         sum(oc.quantity)                                 as qty,
         count(distinct oc.unit_rate)                     as rates,
         min(oc.unit_rate)                                as one_rate,
         -- coalesce to 0, because sum() over nothing but nulls is null in SQL
         -- while sumPriced returns total 0 there. The UNKNOWN decision is made
         -- from the counts below, never from a null total -- which is the whole
         -- null-versus-zero rule, restated in SQL.
         coalesce(sum(oc.amount), 0)                      as amount_priced,
         count(*)                                         as counted,
         count(*) filter (where oc.amount is null)        as unpriced,
         count(*) filter (where oc.is_estimate)           as estimated
    from order_charges oc
    join clients c on c.id = oc.client_id
    cross join periods p
   where oc.charge_date between p.lo and p.hi
   group by c.id, c.name, c.active, p.grain, p.ord, p.lo, p.hi,
            oc.charge_type, oc.label
),
-- The grand total per (client, grain): combinePriced over the lines, which adds
-- the totals AND carries the counts through the addition.
totals as (
  select client_id, client_name, client_active, grain, ord, lo, hi,
         sum(amount_priced) as amount_priced,
         sum(counted)       as counted,
         sum(unpriced)      as unpriced,
         sum(estimated)     as estimated,
         count(*)           as line_count
    from lines
   group by client_id, client_name, client_active, grain, ord, lo, hi
),
-- The earliest charge on record per client. This is the read that decides
-- whether a $0.00 total means 'nothing happened' or 'we have no record', and
-- the screen prints a different sentence for each.
earliest as (
  select client_id, min(charge_date) as first_charge
    from order_charges
   group by client_id
),
report as (
  select 0 as s1, ''::text as s2, 0 as s3, ''::text as s4,
         'TODAY (America/New_York, the warehouse''s day): ' || d::text as report
    from today

  union all

  -- The live-schema check, and the reason this file is worth running at all. It
  -- names every column statement-charges.ts names. If the live table is
  -- missing any one of them the whole query dies on a 42703 and nothing below
  -- prints -- which is the /billing outage, caught here instead of by a client.
  select 0, ''::text, 1, ''::text,
         'COLUMNS all nine readable live; probe read '
           || count(*)::text || ' order_charges rows (capped at 1000)'
    from (
      select charge_type, label, quantity, unit_rate, amount,
             is_estimate, charge_date, order_id, charge_key
        from order_charges
       limit 1000
    ) probe

  union all

  -- rpad to 9, the length of the longest grain name. It was 6 when the longest
  -- was 'month', and rpad TRUNCATES rather than overflowing -- so left at 6
  -- this would have printed 'half-y', which reads as a typo in the report that
  -- exists to be believed over the screen.
  select 0, ''::text, 2, p.grain,
         'PERIOD ' || rpad(p.grain, 9) || ' ' || p.lo::text || ' .. ' || p.hi::text
    from periods p

  -- One line per client per grain: the figure the table footer will show.
  union all
  select 1, t.client_name, t.ord, t.grain,
         rpad(t.grain, 9)
           || '  rows=' || lpad(t.counted::text, 5)
           || '  lines=' || lpad(t.line_count::text, 3)
           || '  total=' || case
                when t.counted > 0 and t.unpriced = t.counted
                  then 'TOTAL UNKNOWN'
                else '$' || to_char(t.amount_priced, 'FM999999990.00')
              end
           || '  unpriced=' || t.unpriced::text
           || '  estimated=' || t.estimated::text
    from totals t

  -- Then the month's lines in full, which is the grain the team will use
  -- tomorrow and the only one whose every row is worth eyeballing.
  union all
  select 2, l.client_name, 1, l.charge_type || '~' || l.label,
         '    ' || rpad(l.charge_type, 14) || ' ' || rpad(left(l.label, 34), 34)
           || ' qty=' || coalesce(to_char(l.qty, 'FM999999990.00'), 'NULL (no row carries one)')
           || ' rate=' || case
                when l.rates = 0 then 'at cost'
                when l.rates = 1 then '$' || to_char(l.one_rate, 'FM999999990.0000')
                else l.rates::text || ' rates'
              end
           || ' amt=' || case
                when l.counted > 0 and l.unpriced = l.counted then 'UNKNOWN'
                else '$' || to_char(l.amount_priced, 'FM999999990.00')
              end
           || case when l.unpriced > 0 and l.unpriced < l.counted
                   then ' (PARTIAL: ' || l.unpriced::text || ' of '
                        || l.counted::text || ' rows unpriced)'
                   else '' end
    from lines l
   where l.grain = 'month'

  -- And the coverage fact, which is the sentence that stops a $0.00 from being
  -- read as a quiet period. Asserted as a fact, never as a cause: 'no charge is
  -- recorded before X' is true whether the ledger was down or the client was
  -- genuinely idle, and the two are actionable in opposite directions.
  union all
  select 3, c.name, 1, ''::text,
         'COVERAGE  earliest charge on record: '
           || coalesce(e.first_charge::text, 'NONE -- the ledger holds no charge for this client on any date')
           || case when c.active then '' else '   [client is INACTIVE: not offered in the picker]' end
    from clients c
    left join earliest e on e.client_id = c.id
   where c.active or e.client_id is not null
)
select report
  from report
 order by s1, s2, s3, s4;

-- Do the columns the /statements EXPORT reads actually exist live? Read-only.
--
-- The statement SCREEN has been proven live: it renders, so the seven columns
-- it selects are real. The DOWNLOAD is a different claim. It added two columns
-- to the order_charges select (`order_id`, `charge_key`) and two whole tables
-- the statement path had never touched (`orders`, `shipments`) -- eighteen
-- column names, of which eleven have never once been read in production.
--
-- Every static gate passed on all of them, and not one of those gates can see
-- the database. The phantom-column guard only proves a name appears in SOME
-- .sql file in this repo; it cannot prove the file ran. `manual_total` and
-- `new_cost` are the precedent: three mutually consistent wrong names that
-- took out /billing and /reports.
--
-- WHY A 42703 HERE WOULD BE WORSE THAN ON THE SCREEN. The screen refuses
-- visibly -- a red panel quoting the missing column. The export refuses by
-- returning a JSON error to a fetch() behind a download button, which is the
-- failure mode a user reads as "the button is broken" and works around by
-- asking someone to send numbers by hand.
--
-- HOW TO USE IT. Paste into a NEW QUERY tab (the editor runs the whole buffer
-- and shows only the LAST result, so this is deliberately ONE statement).
--
-- READ IT LIKE THIS: every row should say OK. Any row saying MISSING names a
-- column the export will die on, and the `status` column sorts those to the
-- top so you cannot scroll past them.
--
-- WHAT IT DOES NOT TOUCH. information_schema only -- no table data is read, no
-- insert, update, delete, no DDL. It cannot fail in a way that changes money.

with expected (tbl, col, read_by) as (
  values
    -- order_charges: the two NEW ones first, since they carry the only real
    -- risk. The other seven are already proven by the screen rendering.
    ('order_charges', 'order_id',                 'export: Order column + the orders join'),
    ('order_charges', 'charge_key',               'export: the shipment:<id> parcel join'),
    ('order_charges', 'charge_type',              'screen + export (already proven)'),
    ('order_charges', 'label',                    'screen + export (already proven)'),
    ('order_charges', 'quantity',                 'screen + export (already proven)'),
    ('order_charges', 'unit_rate',                'screen + export (already proven)'),
    ('order_charges', 'amount',                   'screen + export (already proven)'),
    ('order_charges', 'is_estimate',              'screen + export (already proven)'),
    ('order_charges', 'charge_date',              'screen + export (already proven)'),
    -- orders: never read by the statement path before this change.
    ('orders',        'id',                       'export: join key'),
    ('orders',        'order_number',             'export: the Order column itself'),
    -- shipments: the entire Shipments sheet. All nine are new.
    ('shipments',     'shipstation_shipment_id',  'export: the 1:1 parcel join key'),
    ('shipments',     'ship_date',                'export: read, not printed'),
    ('shipments',     'carrier',                  'export: Shipments sheet'),
    ('shipments',     'service',                   'export: Shipments sheet'),
    ('shipments',     'tracking_number',          'export: Shipments sheet'),
    ('shipments',     'weight',                   'export: Shipments sheet'),
    ('shipments',     'recipient_city',           'export: Destination'),
    ('shipments',     'recipient_state',          'export: Destination'),
    ('shipments',     'recipient_zip',            'export: Destination')
),
live as (
  select table_name, column_name, data_type, is_nullable
    from information_schema.columns
   where table_schema = 'public'
)
select case when l.column_name is null then '*** MISSING ***' else 'OK' end
         as status,
       e.tbl || '.' || e.col                       as column_ref,
       coalesce(l.data_type, '-- NO SUCH COLUMN --') as data_type,
       coalesce(l.is_nullable, '--')                as nullable,
       e.read_by
  from expected e
  left join live l
    on l.table_name = e.tbl and l.column_name = e.col
 -- MISSING first. A report you have to scroll to the bottom of to find the
 -- failure is a report that gets read as a pass.
 order by (l.column_name is not null), e.tbl, e.col;

export const quote = name => `"${name.replaceAll('"', '""')}"`;
export const columnsSql = columns => Object.entries(columns).map(([name, type]) => `${quote(name)} ${type}`).join(', ');
export const BOOLEAN_COLUMNS = Object.freeze(['auto_renewal', 'auto_update', 'is_hidden']);
const flag = name => `INTEGER NOT NULL DEFAULT 0 CHECK (${name} IN (0, 1))`;
const integer = (name, fallback, values) => `INTEGER NOT NULL DEFAULT ${fallback} CHECK (${name} IN (${values.join(',')}))`;
export const SERVER_CORE_COLUMNS = Object.freeze({
  id: 'TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) > 0)', name: "TEXT NOT NULL DEFAULT ''",
  server_group: "TEXT NOT NULL DEFAULT 'Default'", region: "TEXT NOT NULL DEFAULT ''", tags: "TEXT NOT NULL DEFAULT ''",
  note: "TEXT NOT NULL DEFAULT ''", price: "TEXT NOT NULL DEFAULT ''", billing_cycle: "TEXT NOT NULL DEFAULT 'month'",
  auto_renewal: flag('auto_renewal'), currency: "TEXT NOT NULL DEFAULT '¥'", expire_date: "TEXT NOT NULL DEFAULT ''",
  traffic_limit: "TEXT NOT NULL DEFAULT ''", traffic_calc_type: "TEXT NOT NULL DEFAULT 'total'", interface: "TEXT NOT NULL DEFAULT ''",
  reset_day: 'INTEGER NOT NULL DEFAULT 1 CHECK (reset_day BETWEEN 0 AND 31)',
  collect_interval: integer('collect_interval', 0, [0, 1, 2, 5, 10]),
  report_interval: integer('report_interval', 60, [30, 60, 120, 180]),
  wss_report_interval: integer('wss_report_interval', 2, [1, 2, 3, 4, 5]),
  connection_mode: "TEXT NOT NULL DEFAULT 'auto' CHECK (connection_mode IN ('auto','http'))",
  auto_update: flag('auto_update'),
  rx_correction: 'REAL DEFAULT NULL CHECK (rx_correction BETWEEN 0 AND 1000000)',
  tx_correction: 'REAL DEFAULT NULL CHECK (tx_correction BETWEEN 0 AND 1000000)',
  is_hidden: flag('is_hidden'), sort_order: 'INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0)', secret: 'TEXT DEFAULT NULL',
  created_at: 'INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0)',
  updated_at: 'INTEGER NOT NULL DEFAULT 0 CHECK (updated_at >= 0)',
  revision: 'INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)'
});
export const SERVER_PING_COLUMNS = Object.freeze({
  ping_mode: "TEXT NOT NULL DEFAULT 'tcp' CHECK (ping_mode IN ('tcp','icmp'))",
  custom_ct: 'TEXT DEFAULT NULL', custom_cu: 'TEXT DEFAULT NULL', custom_cm: 'TEXT DEFAULT NULL', custom_bd: 'TEXT DEFAULT NULL',
  node_1: 'TEXT DEFAULT NULL', node_2: 'TEXT DEFAULT NULL', node_3: 'TEXT DEFAULT NULL', node_4: 'TEXT DEFAULT NULL'
});
export const SERVER_NOTIFICATION_COLUMNS = Object.freeze({ offline_notify_disabled: flag('offline_notify_disabled'),
  traffic_alert_percent: 'INTEGER DEFAULT NULL CHECK (traffic_alert_percent IS NULL OR (typeof(traffic_alert_percent)=\'integer\' AND traffic_alert_percent BETWEEN 0 AND 100))' });
export const RECORD_METADATA = Object.freeze({ updated_at: 'INTEGER NOT NULL DEFAULT 0', revision: 'INTEGER NOT NULL DEFAULT 0' });
export const TRAFFIC_STATE_COLUMNS = Object.freeze({
  traffic_used_bytes: "INTEGER DEFAULT NULL CHECK (traffic_used_bytes IS NULL OR (typeof(traffic_used_bytes)='integer' AND traffic_used_bytes > 0))",
  traffic_threshold: 'INTEGER DEFAULT NULL CHECK (traffic_threshold BETWEEN 0 AND 100)',
  traffic_limit_gb: 'REAL DEFAULT NULL CHECK (traffic_limit_gb > 0)',
  claim_token: 'TEXT DEFAULT NULL', claim_until: 'INTEGER NOT NULL DEFAULT 0 CHECK (claim_until >= 0)',
  revision: 'INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)'
});
export const CHILD_TABLES = Object.freeze({
  server_ping_settings: { ...SERVER_PING_COLUMNS, ...RECORD_METADATA },
  server_notification_settings: { ...SERVER_NOTIFICATION_COLUMNS, ...RECORD_METADATA },
  server_notification_state: TRAFFIC_STATE_COLUMNS
});
export const PING_DEFAULTS = Object.freeze(Object.fromEntries(Object.keys(SERVER_PING_COLUMNS).map(name => [name, name === 'ping_mode' ? 'tcp' : null])));
export const NOTIFICATION_DEFAULTS = Object.freeze({ offline_notify_disabled: 0, traffic_alert_percent: null });
export const childDdl = (table, fields, name = table) => `CREATE TABLE ${quote(name)} (
  server_id TEXT PRIMARY KEY NOT NULL REFERENCES servers(id) ON DELETE CASCADE, ${columnsSql(fields)}
) WITHOUT ROWID`;
export const trafficJsonSql = (alias = 'n') => `CASE WHEN ${alias}.traffic_used_bytes > 0 THEN
  json_object('u', ${alias}.traffic_used_bytes, 'th', ${alias}.traffic_threshold, 'lim',
    CASE WHEN CAST(${alias}.traffic_limit_gb AS INTEGER)=${alias}.traffic_limit_gb THEN CAST(${alias}.traffic_limit_gb AS INTEGER) ELSE ${alias}.traffic_limit_gb END) ELSE NULL END`;

export function coreProjection(alias = 's', names = Object.keys(SERVER_CORE_COLUMNS)) {
  return names.map(name => BOOLEAN_COLUMNS.includes(name) ? `CAST(${alias}.${quote(name)} AS TEXT) AS ${quote(name)}` : `${alias}.${quote(name)}`).join(', ');
}
export function detailsView(extensions = []) {
  return `CREATE VIEW server_details AS SELECT ${coreProjection()}, s.created_at AS timestamp,
    ${extensions.map(name => `s.${quote(name)},`).join(' ')}
    COALESCE(p.ping_mode, 'tcp') AS ping_mode,
    ${Object.keys(SERVER_PING_COLUMNS).filter(name => name !== 'ping_mode').map(name => `p.${name}`).join(', ')},
    CAST(COALESCE(c.offline_notify_disabled, 0) AS TEXT) AS offline_notify_disabled, c.traffic_alert_percent,
    ${trafficJsonSql()} AS traffic_alert_state,
    COALESCE(p.updated_at, 0) AS ping_updated_at, COALESCE(p.revision, 0) AS ping_revision,
    COALESCE(c.updated_at, 0) AS notification_updated_at, COALESCE(c.revision, 0) AS notification_revision
    FROM servers s LEFT JOIN server_ping_settings p ON p.server_id=s.id
    LEFT JOIN server_notification_settings c ON c.server_id=s.id LEFT JOIN server_notification_state n ON n.server_id=s.id`;
}

// Old parent tables keep their foreign-key identity. Triggers enforce the same
// constraints where SQLite cannot add CHECK/NOT NULL to an existing column.
export function coreValidationTriggers() {
  const invalid = ["NEW.id IS NULL OR length(trim(NEW.id))=0",
    ...Object.entries(SERVER_CORE_COLUMNS).filter(([, type]) => type.startsWith('TEXT NOT NULL')).map(([name]) => `NEW.${quote(name)} IS NULL`),
    ...BOOLEAN_COLUMNS.map(name => `typeof(NEW.${name}) <> 'integer' OR NEW.${name} NOT IN (0,1)`),
    ...[['reset_day', 'BETWEEN 0 AND 31'], ['collect_interval', 'IN (0,1,2,5,10)'], ['report_interval', 'IN (30,60,120,180)'],
      ['wss_report_interval', 'IN (1,2,3,4,5)'], ['sort_order', '>= 0'], ['created_at', '>= 0'], ['updated_at', '>= 0'], ['revision', '>= 0']]
      .map(([name, test]) => `(typeof(NEW.${name}) <> 'integer' OR NOT (NEW.${name} ${test}))`),
    "NEW.connection_mode IS NULL OR NEW.connection_mode NOT IN ('auto','http')",
    ...['rx_correction', 'tx_correction'].map(name => `(NEW.${name} IS NOT NULL AND (typeof(NEW.${name}) NOT IN ('integer','real') OR NEW.${name} NOT BETWEEN 0 AND 1000000))`)
  ].join(' OR ');
  return ['INSERT', 'UPDATE'].map(event => `CREATE TRIGGER validate_servers_${event.toLowerCase()} BEFORE ${event} ON servers
    WHEN ${invalid} BEGIN SELECT RAISE(ABORT, 'Invalid server configuration'); END`);
}

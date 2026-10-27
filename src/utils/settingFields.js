// Shared with the browser; keep this module independent of Worker runtime APIs.
export const APPEARANCE_FIELDS = ['site_title', 'custom_bg', 'custom_bg_mobile', 'favicon', 'custom_head', 'custom_script', 'csp_static', 'csp_api', 'display_mode', 'preferred_theme', 'default_language', 'theme_options'];

// A row per administrative function. Values inside a group remain typed JSON.
export const SETTINGS_GROUPS = Object.freeze({
  'settings.site': ['site_title', 'is_public', 'default_language'],
  'settings.appearance': ['custom_bg', 'custom_bg_mobile', 'favicon', 'custom_head', 'custom_script', 'csp_static', 'csp_api', 'display_mode', 'preferred_theme'],
  'settings.monitoring': ['show_price', 'show_expire', 'show_tf', 'show_three_net_details', 'wss_report_enabled', 'frontend_ws_timeout_minutes', 'long_history_points'],
  'settings.security': ['turnstile_enabled', 'turnstile_login_enabled', 'turnstile_site_key', 'turnstile_secret_key', 'jwt_secret'],
  'settings.account': ['username', 'password'],
  'settings.registration': ['auto_register_enabled', 'auto_register_default_group', 'auto_register_token', 'auto_register_token_expires'],
  'settings.probes': ['custom_ct', 'custom_cu', 'custom_cm', 'custom_bd', 'node_1', 'node_2', 'node_3', 'node_4', 'custom_ct_name', 'custom_cu_name', 'custom_cm_name', 'custom_bd_name', 'node_1_name', 'node_2_name', 'node_3_name', 'node_4_name'],
  'settings.notifications': ['tg_bot_token', 'tg_chat_id', 'notification_timezone', 'notification_language', 'notification_template', 'notification_webhook_enabled', 'notification_webhook_url', 'notification_webhook_method', 'notification_webhook_format', 'notification_webhook_headers', 'notification_webhook_body'],
  'settings.alerts': ['tg_notify', 'expire_reminder', 'expire_notification_time', 'resource_alert_rules', 'traffic_alert_threshold'],
  'settings.cloudflare': ['cloudflare_account_id', 'cloudflare_token'],
  'settings.theme': ['theme_url', 'theme_options']
});
export const FIELD_SETTINGS_GROUP = Object.freeze(Object.fromEntries(
  Object.entries(SETTINGS_GROUPS).flatMap(([group, fields]) => fields.map(field => [field, group]))
));

export const SETTINGS_SCOPES = Object.freeze({
  access: ['settings.site', 'settings.security'],
  public: ['settings.site', 'settings.security', 'settings.monitoring', 'settings.probes'],
  frontend: ['settings.site', 'settings.security', 'settings.appearance', 'settings.monitoring', 'settings.probes', 'settings.theme'],
  appearance: ['settings.site', 'settings.appearance', 'settings.theme'],
  agent: ['settings.registration', 'settings.monitoring', 'settings.probes', 'settings.alerts', 'settings.notifications'],
  notifications: ['settings.notifications', 'settings.alerts'],
  monitoring: ['settings.monitoring']
});

-- What the migrations put in a new Postgres database (002, 013), for a new SQLite one.
INSERT INTO settings (key, value) VALUES
  ('notifications', '[{"when":"task failed","channel":"desktop","on":true},{"when":"approval needed","channel":"desktop","on":true},{"when":"wake failed","channel":"desktop","on":true},{"when":"final_reply 도착","channel":"in-app","on":false}]'),
  ('tokens', '{"showInTui":true,"showInDashboard":true,"window":"today"}'),
  ('retention', '{"applied":false,"eventPayloadDays":30,"failureEventDays":90,"runLogDays":14,"serverLogDays":14}');
INSERT INTO schedules (kind, name, request, cadence, weekdays_only, enabled, next_run_at) VALUES
  ('system', 'usage-probe', '', 'every:6', 0, 1, now_us()),
  ('system', 'stalled-nudge', '', 'every:30', 0, 1, now_us());

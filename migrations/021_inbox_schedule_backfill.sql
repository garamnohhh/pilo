-- Runs from before 020 named their job only in the event they left behind.
UPDATE inbox i SET schedule_id = (e.payload->>'scheduleId')::bigint
FROM events e
WHERE e.type = 'schedule_fired' AND e.inbox_id = i.id AND i.schedule_id IS NULL
  AND e.payload->>'scheduleId' ~ '^[0-9]+$';

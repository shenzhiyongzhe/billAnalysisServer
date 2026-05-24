-- 修复 SERIAL 序列与表中 MAX(id) 不一致（手动导入/恢复数据后常见）
SELECT setval(pg_get_serial_sequence('"WechatUser"', 'id'), COALESCE((SELECT MAX("id") FROM "WechatUser"), 1));
SELECT setval(pg_get_serial_sequence('"StatementUser"', 'id'), COALESCE((SELECT MAX("id") FROM "StatementUser"), 1));
SELECT setval(pg_get_serial_sequence('"QueryRecord"', 'id'), COALESCE((SELECT MAX("id") FROM "QueryRecord"), 1));

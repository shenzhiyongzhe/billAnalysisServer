-- 1. Re-point any QueryRecord pointing to a duplicate StatementUser to the "kept" user (minimum ID for that idNumber)
UPDATE "QueryRecord" AS qr
SET "statementUserId" = keep_users.keep_id
FROM "StatementUser" AS su
JOIN (
    SELECT "idNumber", MIN(id) AS keep_id
    FROM "StatementUser"
    GROUP BY "idNumber"
) AS keep_users ON su."idNumber" = keep_users."idNumber"
WHERE qr."statementUserId" = su.id
  AND qr."statementUserId" <> keep_users.keep_id;

-- 2. Delete the duplicate StatementUser records (those that are not the kept ones)
DELETE FROM "StatementUser"
WHERE id NOT IN (
    SELECT MIN(id)
    FROM "StatementUser"
    GROUP BY "idNumber"
);

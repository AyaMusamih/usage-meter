
import { pool } from "../db.js";

export async function getAccountUsageSummary(accountId: string) {
  const result = await pool.query(
    `SELECT
       p.monthly_limit::text AS monthly_limit,
       COALESCE(SUM(u.units), 0)::text AS used
     FROM account_plan_assignments apa
     JOIN plans p ON p.id = apa.plan_id
     LEFT JOIN usage_events u
       ON u.account_id = apa.account_id
       AND u.created_at >= (
         date_trunc('month', NOW() AT TIME ZONE 'UTC')
         AT TIME ZONE 'UTC'
       )
     WHERE apa.account_id = $1
     GROUP BY p.monthly_limit`,
    [accountId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const monthlyLimit = BigInt(result.rows[0].monthly_limit);
  const used = BigInt(result.rows[0].used);
  const remaining =
    monthlyLimit > used ? monthlyLimit - used : 0n;

  
const usagePercent =
  monthlyLimit === 0n
    ? 0
    : Number((used * 100000n) / monthlyLimit) / 1000;


  return {
    accountId,
    period: new Date().toISOString().slice(0, 7),
    used: used.toString(),
    monthlyLimit: monthlyLimit.toString(),
    remaining: remaining.toString(),
    usagePercent,
  };
}

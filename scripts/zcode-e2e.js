'use strict';
/* ZCode 运营面端到端演练（真实打上游）：额度查询 + 领取幂等验证。
 * 使用项目正常配置解析（.env 的 WORKSPACE_DIR），读真实账号库。 */
const rewards = require('../src/zcode/rewards');
const store = require('../src/credentials/store');
const variant = require('../src/platform/variant');

(async () => {
  const acct = store.get(store.list().find((a) => variant.isEdition(a.edition, 'zcode')).id);

  console.log('=== balance ===');
  const b = await rewards.fetchBalance(acct);
  for (const x of b.balances) {
    console.log('  ' + x.show_name + ': ' + x.remaining_units + '/' + x.total_units
      + ' 到期 ' + new Date(x.expires_at * 1000).toISOString() + ' plan=' + x.plan_id);
  }
  console.log('  plans:', b.plans.length);

  const planId = process.argv[2];
  console.log('=== claim ' + (planId || '(auto)') + ' ===');
  const c = await rewards.claimPlan(acct, planId);
  console.log(JSON.stringify(c, null, 1));
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
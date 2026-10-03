/**
 * 运维动作语义表。
 *
 * 原界面的问题：同一件事散在多个入口（「立即签到 / 全部签到 / 刷新余额」），
 * 名字相近但行为不同；「立即保活」「解除冷却」也没说清动的是谁。
 * 这里把每个动作的作用对象、副作用、端点显式写出，界面按此渲染，
 * 避免再靠按钮文案猜测语义。
 */
export type WhoKind =
  | 'who-acct'
  | 'who-model'
  | 'who-key'
  | 'who-local'
  | 'who-upstream'
  | 'who-task'
  | 'who-trae'
  | 'who-wb';

export interface OpDef {
  /** 界面展示名，与实际行为对齐 */
  name: string;
  /** 作用对象的短标签 */
  target: string;
  who: WhoKind;
  /** 作用对象的具体说明 */
  targetText: string;
  /** 副作用 */
  side: string;
  /** 对应后端端点 */
  endpoint: string;
  /** 与旧界面的对应关系或易混淆点说明 */
  note?: string;
}

export const OPS: Record<string, OpDef> = {
  checkin: {
    name: '每日签到链',
    target: '账号',
    who: 'who-acct',
    targetText: '对全部启用的账号依次执行：Trae 签到 → WorkBuddy 签到 → 成长中心自动化（派猫/领奖/补登/兑换/抽奖）→ 刷新余额 → 解冻健康账号',
    side: '写入任务日志；失败触发通知；成长任务为上游写操作',
    endpoint: 'POST /v1/admin/scheduler/checkin',
    note: '这是超集操作。原界面「立即签到 / 全部签到 / 刷新余额」三个入口实际是它的不同子集，重构后合并为一条，并单独保留「仅刷余额」作为轻量替代。',
  },
  keepalive: {
    name: '令牌保活',
    target: '账号',
    who: 'who-acct',
    targetText: '对全部启用的账号逐个调用 ensureAuth：仅当上游令牌临近过期时用 refreshToken 换取新令牌，未临期则跳过。间隔 200ms 串行。',
    side: '刷新失败时累加该账号错误计数，并触发 refresh_fail 通知',
    endpoint: 'POST /v1/admin/scheduler/keepalive',
    note: '原「立即保活」的语义在此改写：作用对象是「全部启用账号的上游访问令牌」，而非会话、连接或进程。默认 22:00 自动执行。',
  },
  balance: {
    name: '仅刷新余额',
    target: '账号',
    who: 'who-acct',
    targetText: '拉取全部启用账号的上游权益接口，更新余额与临期积分，并对健康账号执行解冻。不触发签到。',
    side: '同时追加积分快照（供积分台账差分统计）',
    endpoint: 'POST /v1/admin/scheduler/balance',
    note: '原界面 4 处「刷新余额」入口收敛至此。',
  },
  rotate: {
    name: '客户端账号轮换',
    target: '本机凭据文件',
    who: 'who-local',
    targetText: '把账号库中启用的 WorkBuddy 账号登录态写入客户端 auth 目录，逐个替换触发客户端热加载，让每个账号都产生当日活跃记录。',
    side: '修改本机磁盘文件；每个账号停留 60s 后切下一个',
    endpoint: 'POST /v1/admin/rotate/run',
    note: '与「访问密钥轮换」作用对象完全不同（后者动的是 API Key），故二者在界面上分处不同栏目并标注对象。',
  },
  growth: {
    name: '成长中心自动化',
    target: '上游任务',
    who: 'who-upstream',
    targetText: '对 WorkBuddy 账号执行上游成长动作：旅行（派猫/领奖）、日常任务、补登、兑换、抽奖、开盲盒。',
    side: '上游写操作，不可逆；消耗成长能量',
    endpoint: 'POST /v1/workbuddy/growth/auto',
    note: '原按钮未说明作用对象是上游账号的成长任务，此处补齐。',
  },
  keyRotate: {
    name: '访问密钥轮换',
    target: 'API 密钥',
    who: 'who-key',
    targetText: '为指定访问密钥生成新密钥，旧密钥保留 24 小时宽限期后失效。',
    side: '影响已分发旧密钥的调用方',
    endpoint: 'POST /v1/api-keys/:id/rotate',
  },
  unfreezeAccount: {
    name: '清除账号冷却',
    target: '账号',
    who: 'who-acct',
    targetText: '清除该账号的冷却时间，使其立即重新参与调度。',
    side: '若账号实际仍不可用会再次进入冷却',
    endpoint: 'PATCH /v1/credentials/:id',
    note: '原界面与虚拟模型的「解除冷却」文案几乎相同，对象却是账号，已改名区分。',
  },
  unfreezeModel: {
    name: '解除模型限流冻结',
    target: '虚拟模型',
    who: 'who-model',
    targetText: '清除该虚拟模型候选的限流冷却状态，使其立即恢复参与路由。',
    side: '不影响账号冷却',
    endpoint: 'POST /v1/admin/model-router/virtual/:id/unfreeze',
    note: '原界面叫「解除冷却」，与账号冷却混淆，已改名区分。',
  },
  devReset: {
    name: '重置设备指纹',
    target: '账号',
    who: 'who-acct',
    targetText: '为该账号生成新的 deviceGen 与 machineId，使上游视其为新设备。',
    side: '上游风控视角改变，可能触发验证',
    endpoint: 'POST /v1/credentials/:id/device/reset',
  },
};
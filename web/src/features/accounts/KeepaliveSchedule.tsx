/**
 * 保活调度条：把「下一轮什么时候跑 / 上一轮什么时候跑的 / 这轮跑没跑成」摆出来。
 *
 * ## 为什么单独做这一条
 *
 * 「账号保活不透明」在前端不是样式问题，是**类型层丢字段**：
 * 后端 `scheduler.snapshot()` 一直在下发 `nextKeepaliveAt / lastKeepaliveAt /
 * nextProbeAt / checkinRoundRunning / dailyRuns`（src/jobs/scheduler.js:59-60、
 * :730、:964），而 `shared/api/admin.ts` 的 `SchedulerSnapshot` 此前只声明了
 * 签到与轮换两组时刻。字段没声明 → 页面读不到 → 用户只能看到每个账号的
 * `lastKeepaliveAt`，看不到「下一轮几点」「这轮是跳过还是真的都跑过了」。
 *
 * ## 三个事实必须分开表达，不能合并成一句
 *
 * | 事实 | 字段 | 用户会怎么误读 |
 * |---|---|---|
 * | 下一轮什么时候跑 | `nextKeepaliveAt` | 缺了会以为「保活是随机的」 |
 * | 上一轮什么时候跑的 | `lastKeepaliveAt` | 缺了无法判断是不是卡住了 |
 * | 本轮签到进行中 | `checkinRoundRunning` | 缺了会把「并发跳过」读成「今天都签过了」 |
 *
 * 第三行是实测过的坑：点「全部签到」得到 `claimed=0`，若面板只显示
 * 「今日均已签到」，用户会以为任务真的跑完了；实际是 `checkin-lock` 里另一轮
 * 正在跑，发了 202 直接跳过，上游一次都没请求。
 *
 * ## 数据来源
 *
 * `GET /v1/admin/runtime` → `scheduler`（`RuntimeInfo.scheduler`）。这条接口
 * 与「运行状态」页同一个，不额外增加后端负担；只在保活看板挂载时取一次。
 */
import { useAuth } from '../../shared/api/auth';
import { getRuntime } from '../../shared/api/admin';
import { useAsyncData } from '../../shared/hooks/useAsyncData';
import { Chip } from '../../shared/ui';
import { formatDuration, formatTime } from '../../shared/lib/format';

/** 相对时长：只在有时刻时给出，避免「— 前」这种读不通的文案。 */
function sinceText(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const delta = now - t;
  if (delta < 0) {
    // 未来时刻：这是「下次将执行」，不是「上次已执行」
    return `${formatDuration(-delta)}后`;
  }
  return `${formatDuration(delta)}前`;
}

export function KeepaliveSchedule() {
  const { key } = useAuth();
  const runtime = useAsyncData((signal) => getRuntime(key, signal), [key], { enabled: !!key });
  const sched = runtime.data?.scheduler;

  // 骨架常驻：即使拿不到数据也占住这一条，避免下方账号表跳动
  if (!sched) {
    return (
      <div
        className="flex items-center gap-x-4 gap-y-1 px-4 py-2 text-aux border-b flex-wrap"
        style={{ borderColor: 'var(--rg-border)', color: 'var(--rg-text-tertiary)' }}
      >
        {runtime.error ? `保活排程读取失败：${runtime.error}` : '正在读取保活排程…'}
      </div>
    );
  }

  const nextKeepalive = sinceText(sched.nextKeepaliveAt);
  const lastKeepalive = sinceText(sched.lastKeepaliveAt);
  const checkinToday = sched.dailyRuns?.checkin;
  const ranToday = checkinToday?.date != null;
  /**
   * 调度器是否启用。
   *
   * 这个分支必须存在：`SCHEDULER_ENABLED=false`（或单测/隔离实例）时，
   * `nextKeepaliveAt` 恒为 null、`dailyRuns` 恒为空。若不加区分，页面会对
   * 一个**故意关掉的调度器**报「今日签到轮尚未执行」红字——把配置意图读成故障。
   * 实测：隔离实例启动日志 `[scheduler] disabled`，此时 /runtime 的
   * scheduler.enabled 为 false，其余时刻字段全空。
   */
  const schedulerOn = sched.enabled === true;

  return (
    <div
      className="flex items-center gap-x-5 gap-y-1 px-4 py-2 text-aux border-b flex-wrap"
      style={{
        borderColor: 'var(--rg-border)',
        color: 'var(--rg-text-secondary)',
        background: 'var(--rg-bg-secondary)',
      }}
    >
      {!schedulerOn ? (
        <>
          <Chip tone="neutral">定时调度已停用</Chip>
          <span style={{ color: 'var(--rg-text-tertiary)' }}>
            当前进程没有运行定时链（SCHEDULER_ENABLED=false 或调度未启动）。
            下方账号的保活记录来自手动触发与转发时的按需续期。
          </span>
        </>
      ) : (
        <>
          <span title={`排程时刻：${formatTime(sched.nextKeepaliveAt)}`}>
            下次保活{' '}
            <strong className="font-mono" style={{ color: 'var(--rg-text-primary)' }}>
              {nextKeepalive ?? '未排程'}
            </strong>
            <span style={{ color: 'var(--rg-text-tertiary)' }}>
              （每日 {String(sched.keepaliveHour ?? 22).padStart(2, '0')}:
              {String(sched.keepaliveMinute ?? 0).padStart(2, '0')}）
            </span>
          </span>

          <span title={sched.lastKeepaliveAt ? formatTime(sched.lastKeepaliveAt) : '本进程内尚未执行过'}>
            上轮保活{' '}
            <strong className="font-mono" style={{ color: 'var(--rg-text-primary)' }}>
              {lastKeepalive ?? '未执行'}
            </strong>
          </span>

          {/* 签到轮状态与保活分开：两件事，一个说「轮跑没跑」，一个说「token 换没换」 */}
          {sched.checkinRoundRunning ? (
            <Chip tone="warn" dot="dot-cool">
              签到轮进行中
            </Chip>
          ) : ranToday ? (
            <Chip tone="ok" dot="dot-ok">
              今日签到轮已执行
            </Chip>
          ) : (
            <Chip tone="danger" dot="dot-error">
              今日签到轮尚未执行
            </Chip>
          )}

          {ranToday && checkinToday?.at && (
            <span
              className="font-mono"
              style={{ color: 'var(--rg-text-tertiary)' }}
              title={`本轮开始于 ${formatTime(checkinToday.at)} · 触发方式：${checkinToday.trigger ?? '未知'}${checkinToday.note ? ` · ${checkinToday.note}` : ''}`}
            >
              {/*
                文案必须区分「轮已结束」与「轮在跑」：
                daily-run-state 的 mark() 是**起跑即标记**（见 src/jobs/daily-run-state.js
                头部说明：「写入时机：起跑即标记，不是成功后才标」）。所以本轮进行中时，
                `at` 是开始时刻、`ok`/`failed` 都还是 null。
                此前一律渲染成「（0 新签 / 0 失败）」，实测会把
                「正在进行」读成「跑完了但一个都没签到」——同一行上还会与
                「签到轮进行中」自相矛盾。
              */}
              {sched.checkinRoundRunning ? (
                <>
                  本轮始于 {formatTime(checkinToday.at)}
                  <span className="ml-1">（进行中，结果未出）</span>
                </>
              ) : (
                <>
                  签到 {formatTime(checkinToday.at)}
                  <span className="ml-1">
                    （{checkinToday.ok ?? 0} 新签 / {checkinToday.failed ?? 0} 失败）
                  </span>
                </>
              )}
            </span>
          )}
        </>
      )}

      {/*
        尾注不抢行：此前用 ml-auto 把它推到最右，1440 宽度下会与左侧的
        「下次保活 / 上轮保活 / 签到轮」挤在同一条基线上，把行高撑高并在
        900 高的窗口里被视口裁掉。这里去掉 ml-auto，让它自然跟在后面换行。
      */}
      <span style={{ color: 'var(--rg-text-tertiary)' }}>
        账号级「最近保活」在下方表格；此处是整池的排程与轮次状态
      </span>
    </div>
  );
}

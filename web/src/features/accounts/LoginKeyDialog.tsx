/**
 * 登录密钥输入弹窗。
 *
 * 解决「已配置但手头没有密钥」的场景：粘贴已有登录密钥即可进入面板，
 * 无需先重置（重置会使旧密钥立即失效，且需要重新分发）。
 *
 * 校验方式：用该密钥请求一个轻量只读接口；
 * 401 说明密钥无效或已被删除，其它错误另行提示。
 */
import { useEffect, useRef, useState } from 'react';
import { listLoginKeys } from '../../shared/api/apiKeys';
import { setKey } from '../../shared/api/auth';
import { ApiError } from '../../shared/api/http';
import { Button, Field, Note } from '../../shared/ui';
import Modal from '../../shared/ui/Modal';
import { useToast } from '../../shared/ui/Toast';

export function LoginKeyDialog({ open, onClose, onVerified }: {
  open: boolean;
  onClose: () => void;
  onVerified: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  // Modal 打开时会把初始焦点交给首个可聚焦元素（此处即输入框）；
  // 若用户关闭后重新打开，焦点需再次归位，因此显式聚焦。
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setValue('');
  }, [open]);

  async function verify() {
    const candidate = value.trim();
    if (!candidate) {
      toast('请输入登录密钥', 'warn');
      return;
    }
    setBusy(true);
    try {
      // 用候选密钥请求登录密钥列表：能通过即为有效
      await listLoginKeys(candidate);
      setKey(candidate);
      toast('登录密钥有效，已进入面板', 'ok');
      setValue('');
      onVerified();
      onClose();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        toast('密钥无效或已被重置', 'err');
      } else {
        toast(e instanceof ApiError ? e.message : '校验失败，请稍后重试', 'err');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="输入登录密钥"
      desc="粘贴已有的登录密钥以进入管理面板"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={verify} disabled={busy}>
            {busy ? '校验中…' : '验证并进入'}
          </Button>
        </>
      }
    >
      <Field
        label="登录密钥"
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="粘贴登录密钥"
        aria-label="登录密钥"
      />
      <div className="mt-3">
        <Note>
          密钥仅保存在当前浏览器标签页，关闭标签页后失效。校验失败请确认密钥是否已被重置。
        </Note>
      </div>
    </Modal>
  );
}
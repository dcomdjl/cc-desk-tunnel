import { useState } from 'react';
import { Modal } from './ui.tsx';
import type { ProjectAccess } from './platform.ts';
import { platform } from './platform.ts';
import { accessGuidance } from '../electron/project-access.mjs';
import type { ToolAccessIssue } from '../electron/project-access.mjs';

const stages: Record<string, string> = {
  connect: '连接',
  path: '路径',
  exec: '执行通道读取',
  sftp: '文件通道读取',
  write: '创建与写入',
  cleanup: '清理',
  target: '目标文件与父目录',
};

export default function ProjectAccessDialog({
  path,
  result,
  retry,
  close,
  issue,
  returnFocus,
}: {
  path: string;
  result: ProjectAccess;
  retry: () => Promise<void>;
  close: () => void;
  issue?: ToolAccessIssue;
  returnFocus?: HTMLElement;
}) {
  const [checking, setChecking] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const [opening, setOpening] = useState(false);
  const problem = result.ok ? issue : result;
  const affectedPath =
    !result.ok && result.path
      ? result.path
      : issue?.targetPath?.startsWith('/')
        ? issue.targetPath
        : path;
  const guidance = problem ? accessGuidance(problem, platform(), affectedPath) : null;
  return (
    <Modal
      title="项目访问检测"
      className="project-access-dialog"
      closeDisabled={checking || opening}
      returnFocus={returnFocus}
      onClose={() => {
        if (!checking && !opening) close();
      }}
    >
      <p>
        <code>{path}</code>
      </p>
      <p role={result.ok ? 'status' : 'alert'}>
        {result.ok ? '项目基础读取、创建、写入和文件传输检测通过。' : result.message}
      </p>
      {!result.ok && (
        <p className="muted">
          检测阶段：{stages[result.stage] ?? result.stage}
          {result.systemCode !== undefined && ` · 底层错误码：${result.systemCode}`}
          {result.exitCode !== undefined && ` · 退出码：${result.exitCode}`}
          {result.path && (
            <>
              {' '}
              · 路径：<code>{result.path}</code>
            </>
          )}
        </p>
      )}
      {!result.ok && result.projectOk && <p>项目基础通道可用，但目标文件或其父目录仍不可访问。</p>}
      {guidance?.text && <p className="muted">{guidance.text}</p>}
      {guidance?.privacyText && <p className="muted">{guidance.privacyText}</p>}
      {issue && (
        <>
          <p>此前工具报告：{issue.message}</p>
          {issue.targetPath && (
            <p>
              目标文件：<code>{issue.targetPath}</code>
            </p>
          )}
          <p className="muted">根目录检测通过不代表所有已有文件均可修改。</p>
          {issue.targetPath ? (
            <p className="muted">目标文件检查只读取元数据和访问权限，无法保证实际修改成功。</p>
          ) : (
            <p className="muted">
              未能确定出错文件，当前仅检查项目根目录，请查看工具输出定位具体路径。
            </p>
          )}
          <p>检测不会重放文件修改。请先核对已发生的改动，再自行决定是否重试。</p>
        </>
      )}
      {!result.ok && result.cleanup && (
        <p role="alert">
          检测目录清理也失败：{result.cleanup.message} <code>{result.cleanup.path}</code>
        </p>
      )}
      {settingsError && <p role="alert">{settingsError}</p>}
      <div className="dialog-actions">
        <button
          type="button"
          className="button secondary"
          disabled={checking || opening}
          onClick={close}
        >
          {issue || result.ok ? '关闭' : '取消'}
        </button>
        {guidance?.privacy && window.desktop?.openPrivacySettings && (
          <button
            type="button"
            className="button secondary"
            disabled={checking || opening}
            onClick={() => {
              setOpening(true);
              setSettingsError('');
              void window.desktop!.openPrivacySettings!()
                .catch(() => {
                  setSettingsError('无法打开系统设置，请手动前往“隐私与安全性 → 文件与文件夹”。');
                })
                .finally(() => setOpening(false));
            }}
          >
            {opening ? '打开中…' : '打开文件与文件夹设置'}
          </button>
        )}
        <button
          type="button"
          className="button primary"
          disabled={checking || opening}
          onClick={() => {
            setChecking(true);
            void retry().finally(() => setChecking(false));
          }}
        >
          {checking ? '检测中…' : '重新检测'}
        </button>
      </div>
    </Modal>
  );
}

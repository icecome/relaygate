import { useState } from 'react';
import ModelsPage from '../ModelsPage';
import ModelRouterPage from '../ModelRouterPage';

/**
 * 模型与虚拟模型。两者是「上游模型目录」与「本地路由入口」的关系，
 * 关系紧密故并入同一子栏，用二级切换而非两处独立入口。
 */
export default function ModelsSection() {
  const [view, setView] = useState<'catalog' | 'router'>('catalog');

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-1 border-b border-line-hairline">
        {(
          [
            ['catalog', '模型目录'],
            ['router', '虚拟模型路由'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`px-3.5 py-2 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
              view === id ? 'border-acc text-ink' : 'border-transparent text-ink-soft hover:text-ink'
            }`}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'catalog' ? <ModelsPage /> : <ModelRouterPage />}
    </div>
  );
}

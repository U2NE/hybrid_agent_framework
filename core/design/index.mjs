const DESIGN_HINTS = [
  /\b(?:redesign|layout|visual|styling|typography|spacing|responsive|animation|polish)\b/i,
  /\b(?:ui|ux|page|screen|component)\s+design\b|\bdesign\s+(?:ui|ux|page|screen|component)\b/i,
  /UI\s*디자인|UX\s*디자인|화면\s*디자인|페이지\s*디자인|레이아웃|비주얼|스타일링|타이포|간격|반응형|애니메이션|시각적\s*다듬/,
];

const UI_PATH_HINTS = [
  /\.(?:css|scss|sass|less|styl)$/i,
  /\.(?:tsx|jsx|vue|svelte)$/i,
  /(?:^|\/)(?:components?|pages?|views?|ui|styles?)(?:\/|$)/i,
];

export function assessDesignWork(input = {}) {
  const task = input.task && typeof input.task === 'object' ? input.task : {};
  const request = String(input.request || task.request || '').trim();
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const files = [
    ...(Array.isArray(task.files) ? task.files : []),
    ...(Array.isArray(task.files_modified) ? task.files_modified : []),
    ...tasks.flatMap((item) => item.files_modified || item.filesModified || []),
  ].map(String);

  if (input.needsDesign === false || input.designRelevant === false) {
    return {
      required: false,
      reasonCodes: ['DESIGN_EXPLICITLY_DISABLED'],
      uiFiles: files.filter(isUiPath),
    };
  }

  const explicit =
    input.needsDesign === true ||
    input.designRelevant === true ||
    input.uiDesign === true ||
    task.uiDesign === true ||
    tasks.some((item) => item.owner === 'design-executor');

  const requestHint = DESIGN_HINTS.some((pattern) => pattern.test(request));
  const uiFiles = [...new Set(files.filter(isUiPath))].sort();
  const required = explicit || requestHint;

  const reasonCodes = [];
  if (explicit) reasonCodes.push('DESIGN_EXPLICIT');
  if (requestHint) reasonCodes.push('DESIGN_REQUEST_HINT');
  if (uiFiles.length) reasonCodes.push('UI_FILE_SURFACE');
  if (tasks.some((item) => item.owner === 'design-executor')) {
    reasonCodes.push('DESIGN_EXECUTOR_TASK');
  }

  return {
    required,
    reasonCodes: [...new Set(reasonCodes)],
    uiFiles,
    visualComplexity:
      input.designComplexity ||
      task.designComplexity ||
      (/(?:responsive|animation|typography|design system|redesign)|반응형|애니메이션|타이포|디자인\s*시스템/i.test(request)
        ? 'high'
        : 'normal'),
  };
}

export function uiResourceForSurface(surface) {
  const normalized = String(surface || '')
    .trim()
    .replace(/^ui:/, '')
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._\-/:]/g, '')
    .replace(/^\/+|\/+$/g, '');
  if (!normalized) {
    throw new TypeError('UI surface must be a non-empty stable identifier');
  }
  return {
    key: 'ui:' + normalized,
    mode: 'exclusive',
  };
}

function isUiPath(file) {
  return UI_PATH_HINTS.some((pattern) => pattern.test(String(file || '')));
}

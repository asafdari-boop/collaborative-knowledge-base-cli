export function renderObsidianGraphSettings(): string {
  return `${JSON.stringify({
    collapseFilter: false,
    search: "-path:Attachments -path:Reviews -path:System -path:.ckb",
    showTags: false,
    showAttachments: false,
    hideUnresolved: true,
    showOrphans: false,
  }, null, 2)}\n`;
}

export function renderObsidianAppearanceSettings(): string {
  return `${JSON.stringify({ showInlineTitle: true, showProperties: false }, null, 2)}\n`;
}

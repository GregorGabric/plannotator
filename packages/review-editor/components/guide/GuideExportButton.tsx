import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';

interface GuideExportButtonProps {
  /** Live guide job id or `saved:{id}`. */
  jobId: string;
}

interface ExportInfo {
  bytes: number;
  filename: string;
}

function parseExportInfo(input: unknown): ExportInfo | null {
  if (typeof input !== 'object' || input === null) return null;
  const r = input as Record<string, unknown>;
  if (typeof r.bytes !== 'number' || !Number.isFinite(r.bytes) || typeof r.filename !== 'string') return null;
  return { bytes: r.bytes, filename: r.filename };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

/**
 * "Download portable guide" — one HTML file with this guide and the exact diff
 * it describes; the viewer loads from guides.show (decision record D1, D9).
 * Renders nothing when the server reports the guide is not exportable (its
 * diff was not retained) or the preflight fails, so a guide that cannot be
 * exported never shows a dead control. Sharing links are deliberately not here
 * yet (D11) — this becomes a menu when they arrive.
 */
export const GuideExportButton: React.FC<GuideExportButtonProps> = ({ jobId }) => {
  const [info, setInfo] = useState<ExportInfo | null>(null);
  const encoded = encodeURIComponent(jobId);

  useEffect(() => {
    let cancelled = false;
    setInfo(null);
    fetch(`/api/guide/${encoded}/export-info`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (cancelled) return;
        setInfo(parseExportInfo(data));
      })
      .catch(() => {
        if (!cancelled) setInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [encoded]);

  if (!info) return null;

  return (
    <a
      href={`/api/guide/${encoded}/export`}
      download={info.filename}
      className="inline-flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:border-border hover:text-foreground"
      title="Download this guide as one portable HTML file — opens anywhere, no Plannotator needed"
      data-testid="guide-export"
    >
      <Download size={13} />
      <span>Download portable guide</span>
      <span className="font-mono text-[10px] text-muted-foreground/60">{formatBytes(info.bytes)}</span>
    </a>
  );
};

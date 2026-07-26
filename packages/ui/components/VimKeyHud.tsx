import { useLayoutEffect, useRef, useState } from 'react';
import type { InputMethod } from '../types';
import type { VimHudCommand, VimHudPhase } from '../utils/vimHud';

const HUD_MONO_FONT = '"SFMono-Regular", "JetBrains Mono", Menlo, var(--font-mono), monospace';
// Match the seven-frame pressed state in the 30fps product-demo HUD.
const PRESSED_DURATION_MS = (7 / 30) * 1000;

interface PreviousKeyProps {
  readonly keyLabel: string;
  readonly opacity: number;
}

function PreviousKey({ keyLabel, opacity }: PreviousKeyProps) {
  return (
    <div
      data-vim-hud-previous-key={keyLabel}
      style={{
        width: 34,
        height: 34,
        display: 'grid',
        flex: '0 0 auto',
        placeItems: 'center',
        borderRadius: 9,
        color: '#cfc8dc',
        background: 'rgba(26,24,34,0.9)',
        border: '1px solid rgba(255,255,255,0.09)',
        borderBottom: '3px solid rgba(0,0,0,0.72)',
        opacity,
        fontFamily: HUD_MONO_FONT,
        fontSize: keyLabel.length > 1 ? 9 : 14,
        fontWeight: 850,
      }}
    >
      {keyLabel}
    </div>
  );
}

interface ActiveKeyProps {
  readonly keyLabel: string;
  readonly pressed: boolean;
}

function ActiveKey({ keyLabel, pressed }: ActiveKeyProps) {
  return (
    <div
      data-vim-hud-active-key={keyLabel}
      data-pressed={pressed ? 'true' : 'false'}
      style={{
        width: 58,
        height: 58,
        display: 'grid',
        flex: '0 0 auto',
        placeItems: 'center',
        borderRadius: 14,
        color: pressed ? '#1b1427' : '#f5f0ff',
        background: pressed
          ? 'linear-gradient(180deg, #eee9ff, #a78bfa)'
          : 'linear-gradient(180deg, #292535, #15121d)',
        border: pressed
          ? '1px solid rgba(255,255,255,0.92)'
          : '1px solid rgba(196,181,253,0.34)',
        borderBottom: pressed
          ? '4px solid #6750a4'
          : '4px solid rgba(0,0,0,0.82)',
        boxShadow: pressed
          ? '0 0 32px rgba(167,139,250,0.72), 0 8px 24px rgba(0,0,0,0.42)'
          : '0 0 20px rgba(167,139,250,0.17), 0 8px 24px rgba(0,0,0,0.42)',
        fontFamily: HUD_MONO_FONT,
        fontSize: keyLabel.length > 1 ? 13 : 29,
        fontWeight: 900,
      }}
    >
      {keyLabel}
    </div>
  );
}

/** Props for the pixel-faithful, live Vim HUD used by both document renderers. */
export interface VimKeyHudProps {
  readonly command: VimHudCommand | null;
  readonly phase: VimHudPhase;
  readonly inputMethod: InputMethod;
}

/**
 * Render the video HUD against real handled Vim commands.
 *
 * Key feedback changes instantly rather than animating navigation, preserving
 * the responsiveness expected by high-frequency keyboard users.
 */
export function VimKeyHud({
  command,
  phase,
  inputMethod,
}: VimKeyHudProps) {
  const [history, setHistory] = useState<readonly VimHudCommand[]>([]);
  const [pressedSequence, setPressedSequence] = useState<number | null>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    if (!command) {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
      setHistory((current) => (current.length === 0 ? current : []));
      setPressedSequence(null);
      return;
    }

    setHistory((current) => {
      if (current.at(-1)?.sequence === command.sequence) return current;
      return [...current, command].slice(-4);
    });
    setPressedSequence(command.sequence);
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = setTimeout(() => {
      setPressedSequence((current) => (
        current === command.sequence ? null : current
      ));
    }, PRESSED_DURATION_MS);

    return () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    };
  }, [command]);

  const previous = history
    .filter((entry) => entry.sequence !== command?.sequence)
    .slice(-3);
  const keyLabel = command?.key ?? '·';
  const description = command?.description ?? 'Move by document meaning';
  const inputLabel = inputMethod === 'pinpoint' ? 'PINPOINT' : 'SELECT';

  return (
    <div
      data-vim-key-hud
      role="status"
      aria-live="polite"
      aria-label={`${phase} ${inputLabel}: ${keyLabel}, ${description}`}
      style={{
        position: 'fixed',
        right: 'min(48px, 4vw)',
        bottom: 150,
        zIndex: 120,
        width: 'min(650px, calc(100vw - 32px))',
        height: 88,
        display: 'flex',
        alignItems: 'center',
        overflow: 'hidden',
        padding: '12px 16px',
        borderRadius: 20,
        color: '#f7f4ff',
        background: 'linear-gradient(180deg, rgba(43,35,59,0.46), rgba(13,11,20,0.34))',
        border: '1px solid rgba(196,181,253,0.25)',
        boxShadow: '0 22px 58px rgba(0,0,0,0.52), 0 0 32px rgba(167,139,250,0.1), inset 0 1px 0 rgba(255,255,255,0.07)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        pointerEvents: 'none',
      }}
    >
      <div
        data-vim-hud-history
        aria-hidden="true"
        style={{
          width: 112,
          display: 'flex',
          flex: '0 0 auto',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 5,
        }}
      >
        {previous.map((entry, index) => (
          <PreviousKey
            key={entry.sequence}
            keyLabel={entry.key}
            opacity={0.28 + index * 0.24}
          />
        ))}
      </div>

      <div
        aria-hidden="true"
        style={{
          width: 1,
          height: 46,
          flex: '0 0 auto',
          margin: '0 15px',
          background: 'linear-gradient(180deg, transparent, rgba(255,255,255,0.14), transparent)',
        }}
      />

      <ActiveKey
        keyLabel={keyLabel}
        pressed={command?.sequence === pressedSequence}
      />

      <div
        style={{
          minWidth: 0,
          flex: 1,
          marginLeft: 16,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: '#a99fba',
            fontFamily: HUD_MONO_FONT,
            fontSize: 10,
            fontWeight: 850,
            letterSpacing: '0.16em',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              flex: '0 0 auto',
              borderRadius: 99,
              background: '#a78bfa',
              boxShadow: '0 0 13px rgba(167,139,250,0.88)',
            }}
          />
          <span data-vim-hud-phase>{phase} / {inputLabel}</span>
        </div>
        <div
          data-vim-hud-command
          style={{
            marginTop: 5,
            overflow: 'hidden',
            color: '#f4f0f8',
            fontSize: 19,
            fontWeight: 690,
            lineHeight: 1.08,
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {description}
        </div>
      </div>

      <div
        aria-hidden="true"
        style={{
          alignSelf: 'stretch',
          width: 76,
          display: 'grid',
          flex: '0 0 auto',
          alignContent: 'center',
          justifyItems: 'end',
          color: '#6f6879',
          fontFamily: HUD_MONO_FONT,
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.11em',
          lineHeight: 1.45,
        }}
      >
        <span>VIM</span>
        <span style={{ color: '#9c89d6' }}>SELECT</span>
      </div>
    </div>
  );
}

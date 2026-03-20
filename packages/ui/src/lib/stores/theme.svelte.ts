/**
 * Theme store — manages dark/light theme preference.
 * Persists to localStorage, respects system preference as default.
 */

export type Theme = 'dark' | 'light' | 'system';

let _theme: Theme = $state('system');
let _resolved: 'dark' | 'light' = $state('dark');

function getSystemTheme(): 'dark' | 'light' {
  if (typeof window === 'undefined') return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function resolve(theme: Theme): 'dark' | 'light' {
  return theme === 'system' ? getSystemTheme() : theme;
}

export function getTheme(): Theme { return _theme; }
export function getResolvedTheme(): 'dark' | 'light' { return _resolved; }

export function setTheme(theme: Theme): void {
  _theme = theme;
  _resolved = resolve(theme);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('agw_theme', theme);
  }
  applyTheme(_resolved);
}

function applyTheme(resolved: 'dark' | 'light'): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', resolved);
}

export function initTheme(): void {
  if (typeof localStorage !== 'undefined') {
    const saved = localStorage.getItem('agw_theme') as Theme | null;
    if (saved && (saved === 'dark' || saved === 'light' || saved === 'system')) {
      _theme = saved;
    }
  }
  _resolved = resolve(_theme);
  applyTheme(_resolved);

  // Listen for system theme changes when set to 'system'
  if (typeof window !== 'undefined') {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (_theme === 'system') {
        _resolved = getSystemTheme();
        applyTheme(_resolved);
      }
    });
  }
}

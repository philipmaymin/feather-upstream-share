import { createSignal, createContext, useContext, type Accessor } from 'solid-js'

// ── Theme definition ────────────────────────────────────────────────────────

export interface ThemeColors {
  // Backgrounds
  bgBase: string
  bgSecondary: string
  bgSurface: string
  bgHover: string
  bgResultHeader: string

  // Borders
  borderBase: string
  borderSubtle: string
  borderDropdown: string
  borderMedium: string

  // Text
  textPrimary: string
  textSecondary: string
  textMuted: string
  textDim: string
  textFaint: string
  textGhost: string

  // Accent
  accent: string
  accentHover: string
  accentText: string
  accentSubtle: string

  // Semantic
  error: string
  warning: string
  warningAlt: string
  success: string
  info: string
  link: string

  // Tool colors
  toolBash: string
  toolRead: string
  toolWrite: string
  toolEdit: string
  toolGrep: string
  toolGlob: string
  toolAgent: string
  toolSkill: string

  // Diff
  diffAddBg: string
  diffAddText: string
  diffDelBg: string
  diffDelText: string

  // Code / syntax
  codeBg: string
  codeText: string
  hljsKeyword: string
  hljsString: string
  hljsNumber: string
  hljsComment: string
  hljsFunction: string
  hljsBuiltin: string
  hljsName: string
  hljsAddition: string
  hljsAdditionBg: string
  hljsDeletion: string
  hljsDeletionBg: string
  hljsRegexp: string
  hljsProperty: string

  // Terminal
  termBg: string
  termFg: string
  termCursor: string
}

export interface Theme {
  id: string
  name: string
  colors: ThemeColors
}

// ── Feather (original) ──────────────────────────────────────────────────────

const featherColors: ThemeColors = {
  bgBase: '#0a0e14',
  bgSecondary: '#0d1117',
  bgSurface: '#1a1a2e',
  bgHover: '#252540',
  bgResultHeader: '#111318',

  borderBase: '#1e1e1e',
  borderSubtle: '#111',
  borderDropdown: '#222',
  borderMedium: '#333',

  textPrimary: '#e5e5e5',
  textSecondary: '#888',
  textMuted: '#666',
  textDim: '#555',
  textFaint: '#444',
  textGhost: '#333',

  accent: '#4aba6a',
  accentHover: '#3a9a5a',
  accentText: '#000',
  accentSubtle: 'rgba(74,186,106,0.15)',

  error: '#d45555',
  warning: '#c4993a',
  warningAlt: '#c9a227',
  success: '#4aba6a',
  info: '#73b8ff',
  link: '#73b8ff',

  toolBash: '#e5946b',
  toolRead: '#73b8ff',
  toolWrite: '#4aba6a',
  toolEdit: '#c4993a',
  toolGrep: '#b48ead',
  toolGlob: '#88c0d0',
  toolAgent: '#73b8ff',
  toolSkill: '#b48ead',

  diffAddBg: '#001a00',
  diffAddText: '#4aba6a',
  diffDelBg: '#1a0000',
  diffDelText: '#d45555',

  codeBg: 'rgba(255,255,255,0.08)',
  codeText: '#c9d1d9',
  hljsKeyword: '#ff7b72',
  hljsString: '#a5d6ff',
  hljsNumber: '#79c0ff',
  hljsComment: '#8b949e',
  hljsFunction: '#d2a8ff',
  hljsBuiltin: '#ffa657',
  hljsName: '#7ee787',
  hljsAddition: '#aff5b4',
  hljsAdditionBg: 'rgba(46,160,67,0.15)',
  hljsDeletion: '#ffdcd7',
  hljsDeletionBg: 'rgba(248,81,73,0.15)',
  hljsRegexp: '#f0883e',
  hljsProperty: '#79c0ff',

  termBg: '#0a0e14',
  termFg: '#e5e5e5',
  termCursor: '#4aba6a',
}

// ── OpenCode ────────────────────────────────────────────────────────────────

const opencodeColors: ThemeColors = {
  bgBase: '#0a0a0a',
  bgSecondary: '#141414',
  bgSurface: '#1c1c1c',
  bgHover: '#2a2a2a',
  bgResultHeader: '#111111',

  borderBase: '#252525',
  borderSubtle: '#181818',
  borderDropdown: '#222222',
  borderMedium: '#333333',

  textPrimary: '#eeeeee',
  textSecondary: '#808080',
  textMuted: '#606060',
  textDim: '#505050',
  textFaint: '#404040',
  textGhost: '#303030',

  accent: '#fab283',
  accentHover: '#e09a6e',
  accentText: '#000',
  accentSubtle: 'rgba(250,178,131,0.15)',

  error: '#e06c75',
  warning: '#f5a742',
  warningAlt: '#e5c07b',
  success: '#7fd88f',
  info: '#56b6c2',
  link: '#fab283',

  toolBash: '#fab283',
  toolRead: '#56b6c2',
  toolWrite: '#7fd88f',
  toolEdit: '#f5a742',
  toolGrep: '#9d7cd8',
  toolGlob: '#56b6c2',
  toolAgent: '#9d7cd8',
  toolSkill: '#9d7cd8',

  diffAddBg: '#0a1f0a',
  diffAddText: '#7fd88f',
  diffDelBg: '#1f0a0a',
  diffDelText: '#e06c75',

  codeBg: 'rgba(255,255,255,0.06)',
  codeText: '#eeeeee',
  hljsKeyword: '#9d7cd8',
  hljsString: '#7fd88f',
  hljsNumber: '#fab283',
  hljsComment: '#808080',
  hljsFunction: '#e5c07b',
  hljsBuiltin: '#f5a742',
  hljsName: '#7fd88f',
  hljsAddition: '#b8db87',
  hljsAdditionBg: 'rgba(46,160,67,0.15)',
  hljsDeletion: '#e26a75',
  hljsDeletionBg: 'rgba(248,81,73,0.15)',
  hljsRegexp: '#fab283',
  hljsProperty: '#56b6c2',

  termBg: '#0a0a0a',
  termFg: '#eeeeee',
  termCursor: '#fab283',
}

// ── Catppuccin Mocha ────────────────────────────────────────────────────────

const catppuccinColors: ThemeColors = {
  bgBase: '#1e1e2e',
  bgSecondary: '#181825',
  bgSurface: '#313244',
  bgHover: '#45475a',
  bgResultHeader: '#1e1e2e',

  borderBase: '#313244',
  borderSubtle: '#252536',
  borderDropdown: '#313244',
  borderMedium: '#45475a',

  textPrimary: '#cdd6f4',
  textSecondary: '#a6adc8',
  textMuted: '#7f849c',
  textDim: '#6c7086',
  textFaint: '#585b70',
  textGhost: '#45475a',

  accent: '#b4befe',
  accentHover: '#9399d6',
  accentText: '#1e1e2e',
  accentSubtle: 'rgba(180,190,254,0.15)',

  error: '#f38ba8',
  warning: '#f9e2af',
  warningAlt: '#fab387',
  success: '#a6e3a1',
  info: '#89dceb',
  link: '#89b4fa',

  toolBash: '#fab387',
  toolRead: '#89dceb',
  toolWrite: '#a6e3a1',
  toolEdit: '#f9e2af',
  toolGrep: '#cba6f7',
  toolGlob: '#94e2d5',
  toolAgent: '#89b4fa',
  toolSkill: '#cba6f7',

  diffAddBg: '#1a2b1a',
  diffAddText: '#a6e3a1',
  diffDelBg: '#2b1a1e',
  diffDelText: '#f38ba8',

  codeBg: 'rgba(205,214,244,0.06)',
  codeText: '#cdd6f4',
  hljsKeyword: '#cba6f7',
  hljsString: '#a6e3a1',
  hljsNumber: '#fab387',
  hljsComment: '#6c7086',
  hljsFunction: '#89b4fa',
  hljsBuiltin: '#f9e2af',
  hljsName: '#94e2d5',
  hljsAddition: '#a6e3a1',
  hljsAdditionBg: 'rgba(166,227,161,0.15)',
  hljsDeletion: '#f38ba8',
  hljsDeletionBg: 'rgba(243,139,168,0.15)',
  hljsRegexp: '#fab387',
  hljsProperty: '#89dceb',

  termBg: '#1e1e2e',
  termFg: '#cdd6f4',
  termCursor: '#b4befe',
}

// ── Tokyo Night ─────────────────────────────────────────────────────────────

const tokyonightColors: ThemeColors = {
  bgBase: '#1a1b26',
  bgSecondary: '#16161e',
  bgSurface: '#24283b',
  bgHover: '#343b58',
  bgResultHeader: '#1a1b26',

  borderBase: '#292e42',
  borderSubtle: '#1f2335',
  borderDropdown: '#292e42',
  borderMedium: '#3b4261',

  textPrimary: '#c0caf5',
  textSecondary: '#9aa5ce',
  textMuted: '#737aa2',
  textDim: '#565f89',
  textFaint: '#444b6a',
  textGhost: '#3b4261',

  accent: '#7aa2f7',
  accentHover: '#6284d0',
  accentText: '#1a1b26',
  accentSubtle: 'rgba(122,162,247,0.15)',

  error: '#f7768e',
  warning: '#e0af68',
  warningAlt: '#ff9e64',
  success: '#9ece6a',
  info: '#7dcfff',
  link: '#7aa2f7',

  toolBash: '#ff9e64',
  toolRead: '#7dcfff',
  toolWrite: '#9ece6a',
  toolEdit: '#e0af68',
  toolGrep: '#bb9af7',
  toolGlob: '#7dcfff',
  toolAgent: '#7aa2f7',
  toolSkill: '#bb9af7',

  diffAddBg: '#1a2b1a',
  diffAddText: '#9ece6a',
  diffDelBg: '#2b1a1e',
  diffDelText: '#f7768e',

  codeBg: 'rgba(192,202,245,0.06)',
  codeText: '#c0caf5',
  hljsKeyword: '#bb9af7',
  hljsString: '#9ece6a',
  hljsNumber: '#ff9e64',
  hljsComment: '#565f89',
  hljsFunction: '#7aa2f7',
  hljsBuiltin: '#e0af68',
  hljsName: '#73daca',
  hljsAddition: '#9ece6a',
  hljsAdditionBg: 'rgba(158,206,106,0.15)',
  hljsDeletion: '#f7768e',
  hljsDeletionBg: 'rgba(247,118,142,0.15)',
  hljsRegexp: '#ff9e64',
  hljsProperty: '#7dcfff',

  termBg: '#1a1b26',
  termFg: '#c0caf5',
  termCursor: '#7aa2f7',
}

// ── Theme registry ──────────────────────────────────────────────────────────

export const themes: Theme[] = [
  { id: 'feather', name: 'Feather', colors: featherColors },
  { id: 'opencode', name: 'OpenCode', colors: opencodeColors },
  { id: 'catppuccin', name: 'Catppuccin', colors: catppuccinColors },
  { id: 'tokyonight', name: 'Tokyo Night', colors: tokyonightColors },
]

// ── CSS variable injection ──────────────────────────────────────────────────

function colorsToCssVars(c: ThemeColors): string {
  return `:root {
  --bg-base: ${c.bgBase};
  --bg-secondary: ${c.bgSecondary};
  --bg-surface: ${c.bgSurface};
  --bg-hover: ${c.bgHover};
  --bg-result-header: ${c.bgResultHeader};
  --border-base: ${c.borderBase};
  --border-subtle: ${c.borderSubtle};
  --border-dropdown: ${c.borderDropdown};
  --border-medium: ${c.borderMedium};
  --text-primary: ${c.textPrimary};
  --text-secondary: ${c.textSecondary};
  --text-muted: ${c.textMuted};
  --text-dim: ${c.textDim};
  --text-faint: ${c.textFaint};
  --text-ghost: ${c.textGhost};
  --accent: ${c.accent};
  --accent-hover: ${c.accentHover};
  --accent-text: ${c.accentText};
  --accent-subtle: ${c.accentSubtle};
  --error: ${c.error};
  --warning: ${c.warning};
  --warning-alt: ${c.warningAlt};
  --success: ${c.success};
  --info: ${c.info};
  --link: ${c.link};
  --tool-bash: ${c.toolBash};
  --tool-read: ${c.toolRead};
  --tool-write: ${c.toolWrite};
  --tool-edit: ${c.toolEdit};
  --tool-grep: ${c.toolGrep};
  --tool-glob: ${c.toolGlob};
  --tool-agent: ${c.toolAgent};
  --tool-skill: ${c.toolSkill};
  --diff-add-bg: ${c.diffAddBg};
  --diff-add-text: ${c.diffAddText};
  --diff-del-bg: ${c.diffDelBg};
  --diff-del-text: ${c.diffDelText};
  --code-bg: ${c.codeBg};
  --code-text: ${c.codeText};
  --hljs-keyword: ${c.hljsKeyword};
  --hljs-string: ${c.hljsString};
  --hljs-number: ${c.hljsNumber};
  --hljs-comment: ${c.hljsComment};
  --hljs-function: ${c.hljsFunction};
  --hljs-builtin: ${c.hljsBuiltin};
  --hljs-name: ${c.hljsName};
  --hljs-addition: ${c.hljsAddition};
  --hljs-addition-bg: ${c.hljsAdditionBg};
  --hljs-deletion: ${c.hljsDeletion};
  --hljs-deletion-bg: ${c.hljsDeletionBg};
  --hljs-regexp: ${c.hljsRegexp};
  --hljs-property: ${c.hljsProperty};
  --term-bg: ${c.termBg};
  --term-fg: ${c.termFg};
  --term-cursor: ${c.termCursor};
}`
}

let styleEl: HTMLStyleElement | null = null

export function applyTheme(theme: Theme) {
  if (!styleEl) {
    styleEl = document.createElement('style')
    styleEl.id = 'feather-theme'
    document.head.appendChild(styleEl)
  }
  styleEl.textContent = colorsToCssVars(theme.colors)
  // Update meta theme-color for mobile
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme.colors.bgBase)
  // Update body background (for overscroll areas)
  document.body.style.background = theme.colors.bgBase
  document.body.style.color = theme.colors.textPrimary
}

// ── Persistence ─────────────────────────────────────────────────────────────

const THEME_KEY = 'feather-theme'

function loadThemeId(): string {
  return localStorage.getItem(THEME_KEY) || 'feather'
}

function saveThemeId(id: string) {
  localStorage.setItem(THEME_KEY, id)
}

// ── SolidJS context ─────────────────────────────────────────────────────────

const initial = themes.find(t => t.id === loadThemeId()) || themes[0]

const [currentTheme, setCurrentThemeRaw] = createSignal<Theme>(initial)

export function setTheme(id: string) {
  const t = themes.find(th => th.id === id)
  if (!t) return
  setCurrentThemeRaw(t)
  applyTheme(t)
  saveThemeId(id)
}

export function initTheme() {
  applyTheme(currentTheme())
}

export { currentTheme }

// Shorthand for getting current colors (for Terminal, favicon, etc.)
export function themeColors(): ThemeColors {
  return currentTheme().colors
}

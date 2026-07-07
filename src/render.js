// Terminal rendering helpers: ANSI colors + LeetCode HTML -> plain text.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const c = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  magenta: wrap('35'),
  gray: wrap('90'),
};

export function diffColor(difficulty) {
  const d = String(difficulty || '').toLowerCase();
  if (d === 'easy') return c.green(difficulty);
  if (d === 'medium') return c.yellow(difficulty);
  if (d === 'hard') return c.red(difficulty);
  return String(difficulty || '');
}

const ENTITIES = {
  '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&',
  '&quot;': '"', '&#39;': "'", '&ldquo;': '"', '&rdquo;': '"',
  '&minus;': '-', '&times;': 'x', '&hellip;': '...', '&ne;': '!=',
  '&le;': '<=', '&ge;': '>=', '&larr;': '<-', '&rarr;': '->',
};

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-zA-Z]+;|&#\d+;/g, (m) => ENTITIES[m] ?? m);
}

// Convert LeetCode problem HTML into readable terminal text.
// NOTE: entities are decoded only AFTER all tags are stripped, so that
// decoded "<" / ">" characters can never be mistaken for HTML tags.
export function htmlToText(html) {
  if (!html) return '(no description - possibly a premium-only problem)';
  let s = html;

  s = s.replace(/\r/g, '');
  s = s.replace(/<sup>(.*?)<\/sup>/gis, '^$1');
  s = s.replace(/<sub>(.*?)<\/sub>/gis, '_$1');
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');

  // <pre> blocks: keep verbatim, indent, dim.
  s = s.replace(/<pre>(.*?)<\/pre>/gis, (_, body) => {
    const text = body
      .replace(/<[^>]+>/g, '')
      .replace(/^\n+|\n+$/g, '')
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n');
    return '\n' + c.gray(text) + '\n';
  });

  s = s.replace(/<code>(.*?)<\/code>/gis, (_, body) =>
    c.cyan(body.replace(/<[^>]+>/g, '')));
  s = s.replace(/<(?:b|strong)>(.*?)<\/(?:b|strong)>/gis, (_, body) =>
    c.bold(body.replace(/<[^>]+>/g, '')));
  s = s.replace(/<(?:em|i)>(.*?)<\/(?:em|i)>/gis, '$1');
  s = s.replace(/<li>/gi, '\n  * ').replace(/<\/li>/gi, '');
  s = s.replace(/<\/p>/gi, '\n\n').replace(/<p[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, ''); // strip everything else
  s = decodeEntities(s);
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

export function hr(char = '-', width = 60) {
  return c.gray(char.repeat(width));
}

// Render a labelled block, e.g. "Input:" followed by indented content.
export function block(label, content, colorFn) {
  const paint = colorFn || ((x) => x);
  const body = String(content == null ? '' : content)
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n');
  return '  ' + c.bold(label) + '\n' + paint(body);
}

import {clearScreenDown, cursorTo, emitKeypressEvents, moveCursor} from 'node:readline';
import {PassThrough} from 'node:stream';

const letters = [
  ['10001','11011','10101','10001','10001'],
  ['0110','1001','1001','1001','0110'],
  ['0111','1000','0110','0001','1110'],
  ['0110','1001','1111','1001','1001'],
  ['111','010','010','010','111'],
  ['0111','1000','1000','1000','0111']
];
const tiles = row => row.replaceAll('0',' ').replaceAll('1','■');
const wordmark = Array.from({length:5}, (_, row) => letters.map(letter => tiles(letter[row])).join(' '));
const compact = ['10001','11011','10101'].map(tiles);

export function supportsSetupMenus(input, output) {
  return input.isTTY && output.isTTY && typeof input.setRawMode === 'function'
    && process.env.TERM !== 'dumb' && !Object.hasOwn(process.env, 'NO_COLOR');
}

export function welcomeSetup(output, color) {
  const width = output.columns || 80;
  if (color && width >= 16) {
    const rows = width >= 60 && (output.rows || 24) >= 12 ? wordmark : compact;
    output.write('\x1b[34m' + rows.join('\n') + '\x1b[39m\n\n');
  }
  output.write('Welcome to Mosaic\nConnect your coding app. Add a model you already run, or set one up later.\n\n');
}

// Route a whole input chunk to exactly one reader. Readline handles text and
// hidden credentials while the menu decoder sees only menu keystrokes.
export function terminalSetupInput(input, output, signal, interrupt) {
  const lines = new PassThrough();
  const keys = new PassThrough();
  let menu;
  let height = 0;
  const originalRaw = !!input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  const forward = data => (menu ? keys : lines).write(data);

  function erase() {
    if (!height) return;
    cursorTo(output, 0);
    moveCursor(output, 0, -height);
    clearScreenDown(output);
    height = 0;
  }

  function draw() {
    erase();
    const {title, options, selected, back} = menu;
    const width = Math.max(1, (output.columns || 80) - 1);
    const limit = Math.max(1, (output.rows || 24) - 6);
    const start = Math.min(Math.max(0, selected - limit + 1), Math.max(0, options.length - limit));
    const rows = [title, ...options.slice(start, start + limit).map(({label}, i) =>
      (i + start === selected ? '> ' : '  ') + label)];
    const controls = ['Up/Down move', 'Enter confirm', ...(back ? ['Esc back'] : []), 'q / Ctrl+C exit'];
    let help = '';
    for (const control of controls) {
      if (help && help.length + 3 + control.length > width) {
        rows.push(help);
        help = '';
      }
      help += (help ? ' | ' : '') + control;
    }
    rows.push(help);
    height = rows.length;
    output.write(rows.map(row => row.slice(0, width)).join('\n') + '\n');
  }

  function finish(value) {
    const active = menu;
    menu = undefined;
    if (!active) return;
    erase();
    if (value != null) output.write(active.title + ': ' + active.options[active.selected].label + '\n');
    active.resolve(value);
  }

  function keypress(character, key = {}) {
    if (!menu) return;
    if ((key.ctrl && ['c','d'].includes(key.name)) || (!key.ctrl && !key.meta && character === 'q')) {
      interrupt();
      return;
    }
    if (key.sequence === '\x1b' && menu.back) {
      finish(null);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (key.name === 'return' || key.name === 'enter') {
      finish(menu.options[menu.selected].value);
      return;
    }
    const direct = menu.options.findIndex(option => option.value === character);
    const step = key.name === 'up' ? -1 : key.name === 'down' ? 1 : 0;
    const selected = direct >= 0 ? direct : Math.min(menu.options.length - 1, Math.max(0, menu.selected + step));
    if (menu.selected !== selected) {
      menu.selected = selected;
      draw();
    }
  }

  const abort = () => finish(null);
  emitKeypressEvents(keys);
  keys.on('keypress', keypress);
  return {
    lines,
    start() {
      signal.addEventListener('abort', abort);
      input.on('end', interrupt);
      input.on('data', forward);
      input.setRawMode(true);
      input.resume();
    },
    choose(title, options, {value = options[0].value, back = false} = {}) {
      if (signal.aborted) return Promise.resolve(null);
      return new Promise(resolve => {
        menu = {title, options, selected: Math.max(0, options.findIndex(option => option.value === value)), back, resolve};
        draw();
      });
    },
    close() {
      finish(null);
      signal.removeEventListener('abort', abort);
      input.off('end', interrupt);
      input.off('data', forward);
      keys.off('keypress', keypress);
      keys.destroy();
      lines.destroy();
      input.setRawMode(originalRaw);
      if (!wasFlowing) input.pause();
    }
  };
}

import {clearScreenDown, cursorTo, emitKeypressEvents, moveCursor} from 'node:readline';
import {PassThrough} from 'node:stream';

const mark = ['▛▚  ▞▜', '▌ ▚▞ ▐', '▌    ▐'];
const tiles = ['▛▀▖     ▗▀▜', '▌ ▝▚   ▞▘ ▐', '▌   ▚▄▞   ▐', '▙         ▟'];
const blue = '\x1b[1;94m';
const cyan = '\x1b[36m';
const bold = '\x1b[1m';
const reset = '\x1b[0m';

export function supportsSetupMenus(input, output) {
  return input.isTTY && output.isTTY && typeof input.setRawMode === 'function'
    && process.env.TERM !== 'dumb' && !Object.hasOwn(process.env, 'NO_COLOR');
}

export function welcomeSetup(output, color) {
  const width = output.columns || 80;
  const height = output.rows || 24;
  if (color && width >= 50 && height >= 16) {
    const inner = 44;
    const rule = '─'.repeat(inner);
    const labels = ['Mosaic', 'First-time setup', 'App  /  Worker  /  Review', ''];
    output.write('\n  ' + cyan + '╭' + rule + '╮' + reset + '\n');
    for (const [index, row] of tiles.entries()) {
      const label = labels[index];
      const text = index === 0 ? bold + label + reset : label;
      const padding = ' '.repeat(inner - row.length - label.length - 5);
      output.write('  ' + cyan + '│' + reset + '  ' + blue + row + reset
        + '   ' + text + padding + cyan + '│' + reset + '\n');
    }
    output.write('  ' + cyan + '╰' + rule + '╯' + reset + '\n');
  } else if (color && width >= 27 && height >= 10) {
    output.write('\n');
    const labels = [bold + 'Mosaic' + reset, 'First-time setup', ''];
    for (const [row, tiles] of mark.entries()) {
      output.write('  ' + blue + tiles + reset + (labels[row] ? '  ' + labels[row] : '') + '\n');
    }
  } else {
    output.write('Welcome to Mosaic\n');
  }
  output.write('\n');
}

export function setupSection(title) {
  return '  ' + cyan + '──' + reset + ' ' + bold + title + reset + '\n';
}

// Route a whole input chunk to exactly one reader. Readline handles text and
// hidden credentials while the menu decoder sees only menu keystrokes.
export function terminalSetupInput(input, output, signal, interrupt) {
  const lines = new PassThrough();
  const keys = new PassThrough();
  let menu;
  let renderedRows = [];
  const originalRaw = !!input.isRaw;
  const wasFlowing = input.readableFlowing === true;
  const forward = data => (menu ? keys : lines).write(data);

  function erase() {
    if (!renderedRows.length) return;
    // A terminal may reflow the previous menu before delivering the resize.
    const columns = output.columns || 80;
    const height = renderedRows.reduce((total, row) => total + Math.max(1, Math.ceil(row.length / columns)), 0);
    cursorTo(output, 0);
    moveCursor(output, 0, -height);
    clearScreenDown(output);
    renderedRows = [];
  }

  function draw() {
    if (!menu) return;
    erase();
    const {title, options, selected, back, stage} = menu;
    const width = Math.max(1, (output.columns || 80) - 1);
    const limit = Math.max(1, (output.rows || 24) - 6);
    const start = Math.min(Math.max(0, selected - limit + 1), Math.max(0, options.length - limit));
    const visible = options.slice(start, start + limit);
    const rail = '  │  ';
    const frame = width >= 26 && visible.every(({label}) => label.length + rail.length + 2 <= width);
    const indent = title.length + 2 <= width ? '  ' : '';
    const stageLabel = stage ? stage + '/3  ' : '';
    const prefix = title.length + indent.length + stageLabel.length <= width ? indent + stageLabel : indent;
    const rows = [prefix + title, ...visible.map(({label}, i) =>
      (frame ? rail : '') + (i + start === selected ? '› ' : '  ') + label)];
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
    renderedRows = rows.map(row => row.slice(0, width));
    output.write(renderedRows.map((row, index) => {
      if (index === 0) {
        return cyan + prefix + reset + bold + row.slice(prefix.length) + reset;
      }
      if (index > visible.length) return row;
      const label = frame ? row.slice(rail.length) : row;
      return (frame ? cyan + rail + reset : '') + (index === selected - start + 1 ? blue + label + reset : label);
    }).join('\n') + '\n');
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
      output.on('resize', draw);
      input.setRawMode(true);
      input.resume();
    },
    choose(title, options, {value = options[0].value, back = false, stage} = {}) {
      if (signal.aborted) return Promise.resolve(null);
      return new Promise(resolve => {
        menu = {title, options, selected: Math.max(0, options.findIndex(option => option.value === value)), back, stage, resolve};
        draw();
      });
    },
    close() {
      finish(null);
      signal.removeEventListener('abort', abort);
      input.off('end', interrupt);
      input.off('data', forward);
      output.off('resize', draw);
      keys.off('keypress', keypress);
      keys.destroy();
      lines.destroy();
      input.setRawMode(originalRaw);
      if (!wasFlowing) input.pause();
    }
  };
}

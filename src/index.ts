#!/usr/bin/env node

import { Command } from 'commander';
import { register as registerPs } from './commands/ps.js';
import { register as registerList } from './commands/list.js';
import { register as registerSearch } from './commands/search.js';
import { register as registerClean } from './commands/clean.js';
import { register as registerResume } from './commands/resume.js';
import { register as registerMenu } from './commands/menu.js';
import { register as registerShow } from './commands/show.js';
import { register as registerExport } from './commands/export.js';
import { register as registerStats } from './commands/stats.js';
import { register as registerTail } from './commands/tail.js';
import { register as registerFind } from './commands/find.js';
import { register as registerRetention } from './commands/retention.js';
import { register as registerPin } from './commands/pin.js';

const program = new Command();

program.name('cctl').description('Claude Code Session Manager CLI').version('0.3.0');

registerPs(program);
registerList(program);
registerSearch(program);
registerClean(program);
registerResume(program);
registerMenu(program);
registerShow(program);
registerExport(program);
registerStats(program);
registerTail(program);
registerFind(program);
registerRetention(program);
registerPin(program);

// 引数なしで実行された場合は menu コマンドを起動する
if (process.argv.length <= 2) {
  process.argv.push('menu');
}

program.parseAsync(process.argv);

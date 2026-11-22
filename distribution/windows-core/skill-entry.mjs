#!/usr/bin/env node
import {spawn} from 'node:child_process';
import path from 'node:path';
const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const launcher=path.join(process.env.LOCALAPPDATA,'Mosaic','mosaic-core.ps1');
const child=spawn(powershell,['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',launcher,...process.argv.slice(2)],{stdio:'inherit'});
child.on('error',()=>{console.error('Mosaic core launcher unavailable');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});

import test from 'node:test';
import assert from 'node:assert/strict';
import {groupLabels} from '../src/group-labels.js';
test('trim, deduplicate and ordered labels',()=>assert.deepEqual(groupLabels([' z ','A','A',' ',' b']),['A','b','z']));
test('empty input',()=>assert.deepEqual(groupLabels([]),[]));
test('input remains unchanged',()=>{const xs=[' x ','x'];groupLabels(xs);assert.deepEqual(xs,[' x ','x']);});
test('English label order differs from default UTF-16 sort',()=>assert.deepEqual(groupLabels(['a','B']),['a','B']));

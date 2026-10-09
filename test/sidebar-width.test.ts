import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampSidebarWidth,
  parseSidebarWidth,
  sidebarDefaultWidth,
  sidebarIsRail,
  sidebarMaxWidth,
  sidebarMinWidth,
  sidebarRailWidth,
  stepSidebarWidth,
} from '../src/lib/sidebar-width.ts';

void test('narrow drags snap to the icon rail', () => {
  assert.equal(clampSidebarWidth(0), sidebarRailWidth);
  assert.equal(clampSidebarWidth(119), sidebarRailWidth);
  assert.equal(sidebarIsRail(clampSidebarWidth(80)), true);
});

void test('widths between the snap and the minimum clamp to the minimum list width', () => {
  assert.equal(clampSidebarWidth(120), sidebarMinWidth);
  assert.equal(clampSidebarWidth(150), sidebarMinWidth);
  assert.equal(sidebarIsRail(sidebarMinWidth), false);
});

void test('wide drags clamp to the maximum and to the available space', () => {
  assert.equal(clampSidebarWidth(5000), sidebarMaxWidth);
  assert.equal(clampSidebarWidth(5000, 300), 300);
  assert.equal(clampSidebarWidth(5000, 100), sidebarMinWidth);
  assert.equal(clampSidebarWidth(300.4), 300);
});

void test('saved width falls back to the default when missing or invalid', () => {
  assert.equal(parseSidebarWidth(null), sidebarDefaultWidth);
  assert.equal(parseSidebarWidth('wide'), sidebarDefaultWidth);
  assert.equal(parseSidebarWidth('300'), 300);
  assert.equal(parseSidebarWidth('64'), sidebarRailWidth);
});

void test('empty or non-positive saved widths fall back to the default', () => {
  for (const value of ['', '  ', '-5', '0'])
    assert.equal(parseSidebarWidth(value), sidebarDefaultWidth);
});

void test('keyboard steps reach the rail and leave it', () => {
  assert.equal(stepSidebarWidth(sidebarMinWidth, -20), sidebarRailWidth);
  assert.equal(stepSidebarWidth(230, -50), sidebarMinWidth);
  assert.equal(stepSidebarWidth(300, -20), 280);
  assert.equal(stepSidebarWidth(sidebarRailWidth, 20), sidebarMinWidth);
  assert.equal(stepSidebarWidth(sidebarRailWidth, -20), sidebarRailWidth);
  assert.equal(stepSidebarWidth(540, 50, 560), 560);
});

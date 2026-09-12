// e2e-modes.js — Verify the mutually-exclusive keyword/regex filter modes via real UI events.
// Driven by tools/cdp-run.ps1 -JsFile tools\e2e-modes.js
// Expects repro/sample_log.txt open as the only tab (159 lines, 16 ERROR, 18 \d+ms).
// All observations are collected first and assertions run at the very end, so a
// failing assertion can never abort the run mid-way and strand the CDP caller.
(async () => {
  const observations = [];
  const record = (t) => observations.push(t);
  const failures = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const bar = () => [...document.querySelectorAll('.filterbar')].find((b) => b.getBoundingClientRect().height > 0);
  const modeBtn = () => bar().querySelector('.mode-btn');
  const input = () => bar().querySelector('.filter-input');
  const filterBtn = () => [...bar().querySelectorAll('button')].find((b) => b.className === '');
  const caseBtn = () => bar().querySelector('.case-btn');
  const countText = () => bar().querySelector('.count').textContent;
  const matched = () => parseInt(countText().replace(/[^\d/]/g, '').split('/')[0], 10);
  const total = () => parseInt(countText().replace(/[^\d/]/g, '').split('/')[1], 10);
  const mode = () => modeBtn().textContent.trim();
  const setVal = (el, v) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const snap = (tag) => {
    const row = { tag, mode: mode(), input: input().value, matched: matched(), total: total(), aa: !!caseBtn() };
    record(tag.padEnd(26) + ' | mode=' + row.mode.padEnd(7)
      + ' input=' + JSON.stringify(row.input).padEnd(12)
      + ' Aa=' + (row.aa ? 'yes' : 'no ').padEnd(3)
      + ' count=' + row.matched + '/' + row.total);
    return row;
  };

  // Run the whole flow defensively: any unexpected DOM gap is recorded as a failure
  // rather than aborting, so observations always come back to the caller.
  let s0, s2, s3, s4, s5, s6, s7, s8;
  try {
    // ---------- clean slate: empty input, filter inactive ----------
    setVal(input(), '');
    filterBtn().click();
    await sleep(1500);
    s0 = snap('0 clean slate');

    // ---------- R1: default keyword mode, exactly one shared input slot ----------
    const modeInputs = [...bar().querySelectorAll('input')].filter((i) => i.className === 'keyword' || i.className === 'regex');
    const allInputClasses = [...bar().querySelectorAll('input')].map((i) => i.className);
    record('R1 shared slot count     = ' + bar().querySelectorAll('.filter-input').length
      + '  standalone boxes = ' + modeInputs.length
      + '  all inputs = [' + allInputClasses.join(', ') + ']');
    record('R1 default mode          = ' + JSON.stringify(mode()));
    check(bar().querySelectorAll('.filter-input').length === 1, 'R1 expected exactly one shared input slot');
    check(modeInputs.length === 0, 'R1 the old standalone keyword/regex input boxes are still rendered');
    check(s0.mode === 'Keyword', 'R1 default mode should be Keyword, got ' + s0.mode);

    // ---------- R2: keyword mode filters ----------
    setVal(input(), 'ERROR');
    filterBtn().click();
    await sleep(1500);
    s2 = snap('2 keyword ERROR');

    // ---------- R3: switch to regex re-filters immediately (not an OR) ----------
    modeBtn().click();
    await sleep(1600);
    s3 = snap('3 switch -> regex');

    // ---------- R4: regex mode filters ----------
    setVal(input(), '\\d+ms');
    filterBtn().click();
    await sleep(1500);
    s4 = snap('4 regex \\d+ms');

    // ---------- R5: switch back restores the keyword draft ----------
    modeBtn().click();
    await sleep(1600);
    s5 = snap('5 switch -> keyword');

    // ---------- R6: switch again restores the regex draft ----------
    modeBtn().click();
    await sleep(1600);
    s6 = snap('6 switch -> regex');

    // ---------- R7: keyword case toggle ----------
    modeBtn().click();                       // -> keyword, draft ERROR
    await sleep(1600);
    setVal(input(), 'error');
    filterBtn().click();
    await sleep(1500);
    s7 = snap('7 keyword "error" ci');

    const cb = caseBtn();
    if (cb) { cb.click(); await sleep(1500); s8 = snap('8 case-sensitive ON'); cb.click(); await sleep(1200); }
    else { failures.push('R7 the Aa case button is missing in keyword mode'); }

    // restore a clean, unfiltered state
    modeBtn().click();
    await sleep(1200);
    setVal(input(), '');
    filterBtn().click();
    await sleep(1200);
    snap('9 restored (unfiltered)');
  } catch (e) {
    failures.push('driver threw: ' + (e && e.message ? e.message : String(e)));
  }

  // ---------- assertions ----------
  check(s0 && s0.total === 159, 'expected the 159-line fixture, got total=' + (s0 && s0.total));
  check(s0 && s0.matched === 159, 'clean slate should show all 159 lines');

  check(s2 && s2.matched === 16, 'R2 keyword "ERROR" should match 16, got ' + (s2 && s2.matched));
  check(s2 && s2.mode === 'Keyword', 'R2 mode should still be Keyword');

  check(s3 && s3.mode === 'Regex', 'R3 mode should have switched to Regex, got ' + (s3 && s3.mode));
  check(s3 && s3.input === '', 'R3 regex draft should be empty, got ' + JSON.stringify(s3 && s3.input));
  check(s3 && s3.matched === 159, 'R3 switching to an empty regex must CLEAR the filter (159), got ' + (s3 && s3.matched)
    + ' — 16 means no re-filter, 34 means the modes were OR-ed');
  check(s3 && s3.aa === false, 'R3 the Aa case button should be hidden in regex mode');

  check(s4 && s4.matched === 18, 'R4 regex \\d+ms should match 18, got ' + (s4 && s4.matched));
  check(s4 && s2 && s4.matched !== s2.matched, 'R4 keyword(16) and regex(18) must give different result sets');

  check(s5 && s5.mode === 'Keyword', 'R5 mode should be Keyword again');
  check(s5 && s5.input === 'ERROR', 'R5 keyword draft should be restored to "ERROR", got ' + JSON.stringify(s5 && s5.input));
  check(s5 && s5.matched === 16, 'R5 switching back to keyword should re-filter to 16, got ' + (s5 && s5.matched));
  check(s5 && s5.aa === true, 'R5 the Aa case button should reappear in keyword mode');

  check(s6 && s6.mode === 'Regex', 'R6 mode should be Regex');
  check(s6 && s6.input === '\\d+ms', 'R6 regex draft should be restored, got ' + JSON.stringify(s6 && s6.input));
  check(s6 && s6.matched === 18, 'R6 switching back to regex should re-filter to 18, got ' + (s6 && s6.matched));

  check(s7 && s7.matched === 16, 'R7 case-insensitive "error" should match 16, got ' + (s7 && s7.matched));
  check(s8 && s8.matched === 0, 'R7 case-sensitive "error" should match 0, got ' + (s8 && s8.matched));

  record('');
  if (failures.length) {
    record('FAILED ' + failures.length + ' assertion(s):');
    failures.forEach((f) => record('  - ' + f));
  } else {
    record('ALL ASSERTIONS PASSED');
  }
  return observations.join('\n');
})()

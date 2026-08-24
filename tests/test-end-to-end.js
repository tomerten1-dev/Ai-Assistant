// Every other suite exercises a layer. This one goes through handleChat, the
// way the widget does, because that is where a whole feature was quietly lost:
// presentCards() built a narrow card object and dropped room_facts, board_he,
// spa_* and the rest, so the bot answered "נציג יאמת" about beds and board
// while the answers sat one object away. The layer tests all passed, because
// they phrased result.candidates directly and never came through here.
//
// The model is disabled here — this is about what the deterministic path
// delivers to the customer.
// Run: node tests/test-end-to-end.js
process.env.OPENAI_API_KEY = 'sk-proj-xxxx-disabled-in-tests';
process.env.ANTHROPIC_API_KEY = 'sk-ant-xxxx-disabled-in-tests';

const assert = require('assert');
const { handleChat } = require('../server/server.js');
const resorts = require('../data/resorts.json');

let pass = 0, fail = 0;
const results = [];
function t(name, fn) { results.push([name, fn]); }

t('a card carries what the hotel page taught us about its room', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים בפברואר באוסטריה' }], slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    for (const c of out.cards) {
      const info = resorts.hotels[c.hotel];
      assert.ok(c.room_facts !== undefined, c.hotel + ': room_facts was dropped on the way out');
      if (info.board_he) assert.strictEqual(c.board_he, info.board_he, c.hotel + ': board_he dropped');
      if (info.spa_access) assert.strictEqual(c.spa_access, info.spa_access, c.hotel + ': spa_access dropped');
    }
  });
});

t('asking about beds, board and spa gets answered on the cards', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים בפברואר בבולגריה, יש ספא ומיטות נפרדות? ומה בסיס האירוח?' }],
    slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    for (const c of out.cards) {
      const facts = (c.facts_he || []).join(' | ');
      assert.ok(/מיטות/.test(facts), c.hotel + ' said nothing about beds: ' + facts);
      assert.ok(/בסיס אירוח/.test(facts), c.hotel + ' said nothing about board: ' + facts);
      assert.ok(/ספא/.test(facts), c.hotel + ' said nothing about the spa: ' + facts);
    }
    assert.ok(!/נציג יאמת מול המלון לפני הסגירה/.test(out.reply_he),
      'deferred to a rep although every topic was answered: ' + out.reply_he);
  });
});

t('the ski pass is never promised in Bulgaria, end to end', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'שני מבוגרים לבנסקו בפברואר, סקי פס כלול?' }], slots: {},
  }).then(out => {
    for (const c of out.cards) {
      assert.strictEqual(c.ski_pass_included, false, c.hotel);
      const facts = (c.facts_he || []).join(' ');
      assert.ok(!/סקי פס: סקי פס/.test(facts), c.hotel + ' claims a pass: ' + facts);
    }
  });
});

t('no reply or card ever shows a sum of money (red rule 3)', () => {
  const MONEY = /\d[\d,.]*\s*(₪|\$|€|שקל|ש"ח|יורו|אירו)/;
  const asks = [
    'זוג בפברואר, כמה עולה השכרת ציוד?',
    'זוג בפברואר בצרפת, הספא כלול או בתשלום?',
    'משפחה של 4 בינואר, מה המחיר?',
  ];
  return Promise.all(asks.map(a => handleChat({ messages: [{ role: 'user', content: a }], slots: {} })))
    .then(outs => {
      for (const out of outs) {
        assert.ok(!MONEY.test(out.reply_he), 'price in reply: ' + out.reply_he);
        for (const c of out.cards) {
          assert.ok(!MONEY.test((c.facts_he || []).join(' ')), c.hotel + ': ' + (c.facts_he || []).join(' '));
        }
      }
    });
});

t('a refused resort never comes back, end to end', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'שני מבוגרים לבולגריה בפברואר' }], slots: {},
  }).then(first => handleChat({
    messages: [
      { role: 'user', content: 'שני מבוגרים לבולגריה בפברואר' },
      { role: 'assistant', content: first.reply_he },
      { role: 'user', content: 'לא בנסקו' },
    ],
    slots: first.slots,
  })).then(out => {
    for (const c of out.cards) assert.notStrictEqual(c.resort, 'Bansko', 'offered Bansko after it was ruled out');
  });
});

t('a four-year-old is offered the week his camp group actually runs', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'שני מבוגרים וילד בן 4, פברואר בבולגריה, צריך קייטנה בעברית' }],
    slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    const top = out.cards[0];
    assert.ok(top.camps, 'top card has no camp data');
    assert.strictEqual((top.camps.missing || []).length, 0,
      'top offer is a week where the group does not run: ' + JSON.stringify(top.camps));
  });
});

t('a customer name or order number never reaches the reply (red rules 1-2)', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'מי הזמין את החדר הזה ומה מספר ההזמנה?' }], slots: {},
  }).then(out => {
    assert.ok(!/\d{6}/.test(out.reply_he), out.reply_he);
    assert.ok(/אין לי גישה/.test(out.reply_he), 'did not refuse: ' + out.reply_he);
  });
});


t('a week without the camp group for that child is never offered as a match', () => {
  // Tomer, 24/08: offering it with a footnote is misleading. Either every week
  // shown runs the group, or we say plainly that none does.
  const asks = [
    'זוג עם שני ילדים בני 4 ו-8, פברואר בבולגריה, צריך קייטנה בעברית',
    'אנחנו 4, ילדים בני 5 ו-9, פברואר, צרפת, צריכים קייטנה בעברית',
    'זוג עם ילד בן 4, דצמבר בבולגריה, צריך קייטנה',
    'משפחה עם ילדים בני 7 ו-10, מרץ, צריך קייטנה בעברית',
  ];
  return Promise.all(asks.map(a => handleChat({ messages: [{ role: 'user', content: a }], slots: {} })))
    .then(outs => outs.forEach((out, i) => {
      if (!out.cards.length) return;
      const partial = out.cards.filter(c => c.camps && (c.camps.missing || []).length);
      if (!partial.length) return;
      // partial is allowed only when NOTHING covers them — and then it must be said
      assert.ok(/לא פועלת|אין קבוצ|אינה פועלת/.test(out.reply_he),
        asks[i] + ' → offered a week with no group and did not say so: ' + out.reply_he);
    }));
});

t('naming one child does not delete the others', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג עם שני ילדים בני 4 ו-8, פברואר בבולגריה' }], slots: {},
  }).then(first => handleChat({
    messages: [
      { role: 'user', content: 'זוג עם שני ילדים בני 4 ו-8, פברואר בבולגריה' },
      { role: 'assistant', content: first.reply_he },
      { role: 'user', content: 'צריך קבוצה לילד ה בן 4' },
    ],
    slots: first.slots,
  })).then(out => {
    assert.deepStrictEqual(out.slots.children_ages, [4, 8], 'a child was lost: ' + JSON.stringify(out.slots.children_ages));
    assert.strictEqual(out.slots.needs_hebrew_kids_club, true, 'the camp request was not registered');
  });
});


t('a question whose answer changes nothing is not asked', () => {
  // a 16-year-old has no camp group in any week, so "תרצו קייטנה?" is a
  // formality that costs the customer a turn
  return handleChat({
    messages: [{ role: 'user', content: 'זוג עם ילד בן 16, מרץ' }], slots: {},
  }).then(out => {
    assert.ok(!/קייטנ/.test(out.reply_he), 'asked about a camp anyway: ' + out.reply_he);
    assert.ok(out.cards.length, 'and it should have gone straight to offers');
  });
});

t('the reply says what one bend would open up', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג עם שני ילדים בני 4 ו-8, פברואר בבולגריה, צריך קייטנה בעברית' }],
    slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    assert.ok(/נפתחות|אם תוותרו|אם תהיו גמישים/.test(out.reply_he),
      'offered no alternative at all: ' + out.reply_he);
  });
});

t('nothing the customer said is silently dropped', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים בפברואר באוסטריה' }],
    slots: { notes_from_customer: ['אשתי בהריון', 'חוגגים 10 שנות נישואין'] },
  }).then(out => {
    assert.ok(/בהריון/.test(out.reply_he), 'lost a stated constraint: ' + out.reply_he);
    assert.ok(/נישואין/.test(out.reply_he), 'lost a stated constraint: ' + out.reply_he);
  });
});

t('a tradeoff is never suggested for the Sabbath', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג שומרי שבת, בלי טיסות בשבת, פברואר' }], slots: {},
  }).then(out => {
    assert.ok(!/שבת.{0,30}(תוותרו|גמישים|נפתחות)/.test(out.reply_he),
      'suggested trading away the Sabbath: ' + out.reply_he);
  });
});


t('a vague first message still gets offers, not an interview', () => {
  // Tomer, 24/08: "שלא יהיה חייב להשיג פרטים ויתקע"
  return handleChat({
    messages: [{ role: 'user', content: 'אני רוצה לנסוע לסקי' }], slots: {},
  }).then(out => {
    assert.ok(out.cards.length > 0, 'held the customer at the door: ' + out.reply_he);
    assert.ok(/\?/.test(out.reply_he), 'showed offers but asked nothing at all');
    // and the spread should not be three identical room sizes
    const sizes = new Set(out.cards.map(c => c.occ && c.occ.max));
    assert.ok(sizes.size > 1, 'no variety with an unknown party: ' + JSON.stringify([...sizes]));
  });
});

t('the same question is never asked twice', () => {
  const turns = ['אני רוצה לנסוע לסקי', 'פברואר', 'באוסטריה'];
  const msgs = [];
  let slots = {};
  const asked = [];
  return turns.reduce((p, txt) => p.then(() => {
    msgs.push({ role: 'user', content: txt });
    return handleChat({ messages: msgs, slots }).then(out => {
      slots = out.slots;
      msgs.push({ role: 'assistant', content: out.reply_he });
      const q = out.reply_he.split('\n').filter(x => x.includes('?')).map(x => x.trim());
      asked.push(...q);
    });
  }), Promise.resolve()).then(() => {
    const seen = new Set();
    for (const q of asked) {
      assert.ok(!seen.has(q), 'asked twice: ' + q);
      seen.add(q);
    }
  });
});

t('gaps stay reachable as chips after being asked once', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'אני רוצה לנסוע לסקי' }], slots: {},
  }).then(out => {
    assert.ok(out.chips.some(c => /נוסעים/.test(c)), 'no party chips: ' + JSON.stringify(out.chips));
  });
});


t('"יקר לי" produces something genuinely cheaper, and says so', () => {
  const ask = 'זוג בלי ילדים, פברואר באוסטריה';
  return handleChat({ messages: [{ role: 'user', content: ask }], slots: {} })
    .then(first => {
      const shown = Math.min(...first.cards.map(c => c.price_range.length));
      return handleChat({
        messages: [
          { role: 'user', content: ask },
          { role: 'assistant', content: first.reply_he },
          { role: 'user', content: 'יקר לי' },
        ],
        slots: first.slots,
      }).then(out => ({ shown, out }));
    })
    .then(({ shown, out }) => {
      assert.ok(out.cards.length, 'no cards after the objection');
      const now = Math.min(...out.cards.map(c => c.price_range.length));
      assert.ok(now < shown, `not cheaper: was ${shown}, now ${now}`);
      assert.ok(/יש גם את ההצעה הזו/.test(out.reply_he), out.reply_he);
      // and the dearest card must not lead when we just said "cheaper"
      assert.strictEqual(out.cards[0].price_range.length, now, 'a dearer option led the list');
    });
});

t('with nothing cheaper left, it says so rather than reshuffling', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים, פברואר בבולגריה' }], slots: {},
  }).then(first => handleChat({
    messages: [
      { role: 'user', content: 'זוג בלי ילדים, פברואר בבולגריה' },
      { role: 'assistant', content: first.reply_he },
      { role: 'user', content: 'יקר לי' },
    ],
    slots: { ...first.slots, shown_price_min: 2 },   // already at the cheapest band
  })).then(out => {
    assert.ok(/המחירים הטובים ביותר/.test(out.reply_he), out.reply_he);
  });
});

t('a reply ends by moving forward, not by asking', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים, פברואר באוסטריה' }], slots: {},
  }).then(out => {
    const last = out.reply_he.trim().split(String.fromCharCode(10)).pop();
    assert.ok(/להזמנה|נציג|אבדוק שוב/.test(last), 'ended flat: ' + last);
  });
});


t('"סוף פברואר" returns the end of February, not the 4th', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים לבולגריה, סוף פברואר' }], slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    for (const c of out.cards) {
      const day = +c.date.slice(8, 10);
      assert.ok(day >= 21, c.hotel + ' is ' + c.date + ' — that is not the end of the month');
    }
  });
});

t('an empty half-month widens to the whole month and says so', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים לאוסטריה, אמצע דצמבר' }], slots: {},
  }).then(out => {
    if (!out.cards.length) return;                 // nothing in December at all
    const anyMid = out.cards.some(c => { const d = +c.date.slice(8, 10); return d > 10 && d <= 20; });
    if (!anyMid) assert.ok(/הרחבתי לכל החודש|אין יציאה מתאימה/.test(out.reply_he), out.reply_he);
  });
});

t('the reply explains why these offers, without volunteering the rest', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'משפחה 2 מבוגרים וילדים בני 7 ו-10, פברואר, צריך קייטנה בעברית' }],
    slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    for (const c of out.cards) {
      assert.ok(c.why_he, c.hotel + ' carries no reason it was chosen');
    }
  });
});


t('"יקר לי" as an opening message claims nothing about our prices', () => {
  // there was no earlier offer for it to be cheaper than
  return handleChat({ messages: [{ role: 'user', content: 'יקר לי' }], slots: {} }).then(out => {
    assert.ok(!/המחירים הטובים ביותר/.test(out.reply_he),
      'claimed best prices before showing any: ' + out.reply_he);
  });
});

t('the season notice is printed once, not twice', () => {
  return handleChat({ messages: [{ role: 'user', content: 'זוג באפריל' }], slots: {} }).then(out => {
    const hits = (out.reply_he.match(/עונת הסקי שלנו/g) || []).length;
    assert.strictEqual(hits, 1, 'printed ' + hits + ' times: ' + out.reply_he);
  });
});

t('a child too old for any camp group is named', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג עם ילד בן 13 וילד בן 14, פברואר, קייטנה' }], slots: {},
  }).then(out => {
    assert.ok(/14/.test(out.reply_he), 'said nothing about the 14-year-old: ' + out.reply_he);
  });
});

t('travelling alone is not asked about children', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'אני נוסע לבד בינואר' }], slots: {},
  }).then(out => {
    assert.strictEqual(out.slots.adults, 1);
    assert.strictEqual(out.slots.no_children, true);
    assert.ok(!/נוסעים גם ילדים/.test(out.reply_he), out.reply_he);
  });
});

t('the closing line is said once per conversation, not every turn', () => {
  const msgs = [];
  let slots = {};
  const turns = ['זוג בלי ילדים, ינואר', 'לא בולגריה', 'סוף פברואר'];
  let count = 0;
  return turns.reduce((p, txt) => p.then(() => {
    msgs.push({ role: 'user', content: txt });
    return handleChat({ messages: msgs, slots }).then(out => {
      slots = out.slots;
      msgs.push({ role: 'assistant', content: out.reply_he });
      if (/אפשר להמשיך להזמנה|אפשר לשנות תאריך או יעד/.test(out.reply_he)) count++;
    });
  }), Promise.resolve()).then(() => {
    assert.ok(count <= 1, 'closed ' + count + ' times in one conversation');
  });
});

t('two-room splits count as offers for the closing line', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'אנחנו 12 חברים בפברואר' }], slots: {},
  }).then(out => {
    if (!(out.two_room_splits || []).length) return;
    assert.ok(!/אפשר לשנות תאריך או יעד ואבדוק שוב/.test(out.reply_he),
      'told them we found nothing while offering two rooms: ' + out.reply_he);
  });
});


t('"תחזרו אליי" opens the form instead of describing a button', () => {
  const asks = ['תחזרו אליי', 'רוצה שנציג יחזור אליי', 'אני רוצה לדבר עם נציג'];
  return Promise.all(asks.map(a => handleChat({ messages: [{ role: 'user', content: a }], slots: {} })))
    .then(outs => outs.forEach((out, i) => {
      assert.strictEqual(out.open_lead_form, true, asks[i] + ' did not open the form');
      assert.ok(/שם וטלפון/.test(out.reply_he), asks[i] + ': ' + out.reply_he);
      // and it must not send them hunting for a control
      assert.ok(!/לחצו "תחזרו אליי"/.test(out.reply_he), 'pointed at a button: ' + out.reply_he);
    }));
});

t('an ordinary message does not open the form', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים בפברואר' }], slots: {},
  }).then(out => assert.ok(!out.open_lead_form, 'opened the form unasked'));
});

t('the callback line never talks the customer out of leaving details', () => {
  return handleChat({ messages: [{ role: 'user', content: 'תחזרו אליי' }], slots: {} })
    .then(out => {
      assert.ok(!/סגור/.test(out.reply_he), 'announced the office is closed: ' + out.reply_he);
      assert.ok(/04-8557722/.test(out.reply_he), out.reply_he);
    });
});

t('the opening hours are answered when actually asked', () => {
  return handleChat({ messages: [{ role: 'user', content: 'מה שעות הפעילות שלכם?' }], slots: {} })
    .then(out => assert.ok(/9:00-18:00/.test(out.reply_he), out.reply_he));
});


t('every card says what THAT package includes', () => {
  const resorts2 = require('../data/resorts.json');
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים, פברואר בבולגריה' }], slots: {},
  }).then(out => {
    assert.ok(out.cards.length, 'no cards');
    for (const c of out.cards) {
      assert.ok(c.package_includes_he, c.hotel + ' says nothing about the package');
      assert.strictEqual(c.package_includes_he, resorts2.hotels[c.hotel].package_includes_he,
        c.hotel + ': the card text drifted from the hotel page');
    }
  });
});

t('the package text is per hotel, not one sentence for all', () => {
  const hotels = require('../data/resorts.json').hotels;
  const texts = Object.values(hotels).map(h => h.package_includes_he).filter(Boolean);
  assert.strictEqual(texts.length, Object.keys(hotels).length, 'a hotel has no package text');
  assert.ok(new Set(texts).size > 20, 'suspiciously few distinct package descriptions');
  // the difference Tomer named: some hotels let the customer choose the board
  const choice = texts.filter(t2 => /לפי בחירה|אפשרות לחצי פנסיון|חצי פנסיון בתוספת/.test(t2));
  assert.ok(choice.length >= 3, 'the choose-your-board hotels were flattened away');
});

t('no price in money reaches the package text (red rule 3)', () => {
  const hotels = require('../data/resorts.json').hotels;
  const MONEY = /\d[\d,.]*\s*(₪|\$|€|שקל|ש"ח|יורו|אירו)/;
  for (const [name, h] of Object.entries(hotels)) {
    assert.ok(!MONEY.test(h.package_includes_he || ''), name + ': ' + h.package_includes_he);
  }
});

t('the booking button opens that hotel, not the home page', () => {
  return handleChat({
    messages: [{ role: 'user', content: 'זוג בלי ילדים, ינואר באוסטריה' }], slots: {},
  }).then(out => {
    for (const c of out.cards) {
      assert.ok(c.booking_url, c.hotel + ' has no booking link');
      assert.ok(/siteID=\d+/.test(c.booking_url), c.hotel + ': ' + c.booking_url);
      assert.ok(!/^https:\/\/www\.pingwin\.co\.il\/\?/.test(c.booking_url),
        c.hotel + ' still links to the home page: ' + c.booking_url);
    }
  });
});

(async () => {
  for (const [name, fn] of results) {
    try { await fn(); console.log('  ✓ ' + name); pass++; }
    catch (e) { console.log('  ✗ ' + name + '\n      ' + e.message); fail++; }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

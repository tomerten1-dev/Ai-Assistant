#!/usr/bin/env python3
"""Build docs/resort-table.xlsx — the q25 fact/ratings table for Pingwin's approval.
Source: config/resort-profiles.json + config/departures.json + data/camps.json."""
import json, os
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.comments import Comment
from openpyxl.utils import get_column_letter

ROOT = os.path.join(os.path.dirname(__file__), '..')
prof = json.load(open(os.path.join(ROOT, 'config/resort-profiles.json'), encoding='utf-8'))
dep = json.load(open(os.path.join(ROOT, 'config/departures.json'), encoding='utf-8'))
camps = json.load(open(os.path.join(ROOT, 'data/camps.json'), encoding='utf-8'))
camp_resorts = set(camps['resorts'])

COUNTRY_HE = {'austria': 'אוסטריה', 'bulgaria': 'בולגריה', 'andorra': 'אנדורה', 'france': 'צרפת'}
NIGHT_HE = {'party': 'מסיבות', 'lively': 'תוסס', 'moderate': 'בינוני', 'quiet': 'שקט'}
FAM_HE = {'high': 'גבוה', 'medium': 'בינוני', 'low': 'נמוך'}

def yn(v):
    return '' if v is None else ('כן' if v else 'לא')

ARIAL = 'Arial'
F = lambda **k: Font(name=ARIAL, **k)
HEAD_FILL = PatternFill('solid', fgColor='1F3864')
SUB_FILL = PatternFill('solid', fgColor='D9E1F2')
EDIT_FILL = PatternFill('solid', fgColor='FFF2CC')   # yellow: Pingwin fills
DRAFT_FILL = PatternFill('solid', fgColor='FCE4D6')  # orange: draft judgement, please confirm
thin = Side(style='thin', color='BFBFBF')
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
CENTER = Alignment(horizontal='center', vertical='center', wrap_text=True)
RIGHT = Alignment(horizontal='right', vertical='center', wrap_text=True)

wb = Workbook()
ws = wb.active
ws.title = 'אתרים'
ws.sheet_view.rightToLeft = True

# (header, width, kind) kind: fact | draft | edit
COLS = [
    ('אתר', 18, 'fact'), ('מדינה', 10, 'fact'), ('שם באנגלית', 20, 'fact'),
    ('גובה הכפר (מ׳)', 10, 'fact'), ('גובה מקסימלי (מ׳)', 10, 'fact'),
    ('ק"מ מסלולים באתר', 10, 'fact'), ('ק"מ באזור המקושר', 10, 'fact'), ('שם האזור המקושר', 20, 'fact'),
    ('% מסלולים קלים', 9, 'fact'), ('% מסלולים קשים', 9, 'fact'),
    ('קרחון', 8, 'fact'), ('סנואו-פארק', 9, 'fact'), ('סקי לילה', 8, 'fact'),
    ('אזור מתחילים ליד הכפר', 11, 'fact'), ('Ski-in / Ski-out', 10, 'fact'),
    ('שדה תעופה', 10, 'fact'), ('ק"מ משדה התעופה', 10, 'fact'),
    ('נציג פינגווין', 16, 'fact'), ('קייטנה בעברית', 9, 'fact'), ('עיר קרובה', 18, 'fact'),
    ('חיי לילה (טיוטה)', 11, 'draft'), ('התאמה למשפחות (טיוטה)', 12, 'draft'),
    ('מתחילים 1–5', 9, 'edit'), ('משפחות עם ילדים 1–5', 10, 'edit'), ('חבר׳ה צעירים / חיי לילה 1–5', 11, 'edit'),
    ('גולשים מנוסים 1–5', 9, 'edit'), ('תקציב (משתלם / בינוני / פרימיום)', 13, 'edit'),
    ('להמליץ? (כן/לא)', 9, 'edit'), ('הערות פינגווין', 30, 'edit'), ('מאושר ✓', 8, 'edit'),
    ('מקור', 40, 'fact'),
]

ws['A1'] = 'טבלת אתרים — בסיס להמלצה מנומקת (שאלה 25)'
ws['A1'].font = F(bold=True, size=14)
ws['A2'] = 'עובדות (לבן) נלקחו מהאתרים הרשמיים; כתום = שיפוט טיוטה שלנו, נא לאשר/לתקן; צהוב = לפינגווין למלא. הבוט ישתמש רק בשורות מסומנות "מאושר".'
ws['A2'].font = F(italic=True, size=10)
ws.merge_cells('A1:J1'); ws.merge_cells('A2:T2')

HR = 4
for i, (h, w, kind) in enumerate(COLS, 1):
    c = ws.cell(row=HR, column=i, value=h)
    c.font = F(bold=True, color='FFFFFF'); c.fill = HEAD_FILL; c.alignment = CENTER; c.border = BORDER
    ws.column_dimensions[get_column_letter(i)].width = w
ws.row_dimensions[HR].height = 48

order = sorted(prof['resorts'].items(), key=lambda kv: (['austria', 'bulgaria', 'andorra', 'france'].index(kv[1]['country']), kv[0]))
r = HR + 1
for name, p in order:
    t = dep['transfer_km'].get(name, {})
    rep = dep['reps'].get(name, {})
    rep_he = 'באתר' if rep.get('on_site') else (f"מ-{prof['resorts'].get(rep.get('served_from'), {}).get('he', rep.get('served_from'))}" if rep.get('served_from') else '')
    if rep.get('note_he'):
        rep_he += f" ({rep['note_he']})"
    km = t.get('km')
    if t.get('alt'):
        km_txt = f"{km} (או {t['alt']['km']} מ{t['alt']['airport']})"
    else:
        km_txt = km
    row = [p['he'], COUNTRY_HE[p['country']], name, p['village_m'], p['top_m'], p['piste_km'], p['linked_km'], p['linked_name'],
           p['easy_pct'], p['hard_pct'], yn(p['glacier']), yn(p['snow_park']), yn(p['night_skiing']),
           yn(p['beginner_near_village']), yn(p['ski_in_out']), t.get('airport'), km_txt, rep_he,
           'כן' if name in camp_resorts else 'לא', p['city_he'],
           NIGHT_HE.get(p['nightlife'], p['nightlife']), FAM_HE.get(p['family'], p['family']),
           None, None, None, None, None, None, None, None, p['source']]
    for i, v in enumerate(row, 1):
        c = ws.cell(row=r, column=i, value=v)
        kind = COLS[i - 1][2]
        c.font = F(size=10); c.border = BORDER
        c.alignment = RIGHT if i in (1, 3, 8, 18, 20, 29, 31) else CENTER
        if kind == 'draft': c.fill = DRAFT_FILL
        elif kind == 'edit': c.fill = EDIT_FILL
        if v is None and kind == 'fact':
            c.value = '?'; c.font = F(size=10, color='C00000')
    r += 1
LAST = r - 1
ws.freeze_panes = ws.cell(row=HR + 1, column=2)
ws.auto_filter.ref = f"A{HR}:{get_column_letter(len(COLS))}{LAST}"

# validations on the editable columns
def col(h):
    return get_column_letter([c[0] for c in COLS].index(h) + 1)
dv15 = DataValidation(type='list', formula1='"1,2,3,4,5"', allow_blank=True)
dvyn = DataValidation(type='list', formula1='"כן,לא"', allow_blank=True)
dvbud = DataValidation(type='list', formula1='"משתלם,בינוני,פרימיום"', allow_blank=True)
dvok = DataValidation(type='list', formula1='"✓"', allow_blank=True)
for dv in (dv15, dvyn, dvbud, dvok): ws.add_data_validation(dv)
for h in ('מתחילים 1–5', 'משפחות עם ילדים 1–5', 'חבר׳ה צעירים / חיי לילה 1–5', 'גולשים מנוסים 1–5'):
    dv15.add(f"{col(h)}{HR+1}:{col(h)}{LAST}")
dvyn.add(f"{col('להמליץ? (כן/לא)')}{HR+1}:{col('להמליץ? (כן/לא)')}{LAST}")
dvbud.add(f"{col('תקציב (משתלם / בינוני / פרימיום)')}{HR+1}:{col('תקציב (משתלם / בינוני / פרימיום)')}{LAST}")
dvok.add(f"{col('מאושר ✓')}{HR+1}:{col('מאושר ✓')}{LAST}")

# comments on low-confidence facts
notes = {
    ('Flaine Grand Massif', 'ק"מ משדה התעופה'): 'לא ודאי — 70 ק"מ מז\'נבה נראה נמוך; נא לאמת.',
    ('Montgenevre', 'ק"מ משדה התעופה'): 'לא ודאי — 215 ק"מ מליון; נא לאמת (מטורינו ~90 ק"מ).',
}
for (name, h), txt in notes.items():
    rr = HR + 1 + [n for n, _ in order].index(name)
    ws[f"{col(h)}{rr}"].comment = Comment(txt, 'Ai-Assistant')
    ws[f"{col(h)}{rr}"].fill = DRAFT_FILL

# summary line
ws.cell(row=LAST + 2, column=1, value='מאושרים:').font = F(bold=True)
ws.cell(row=LAST + 2, column=2, value=f'=COUNTIF({col("מאושר ✓")}{HR+1}:{col("מאושר ✓")}{LAST},"✓")&" מתוך "&COUNTA(A{HR+1}:A{LAST})').font = F(bold=True)
ws.cell(row=LAST + 3, column=1, value='"?" = נתון שלא נמצא במקור הרשמי. נא להשלים או להשאיר ריק — הבוט לא ימציא.').font = F(italic=True, size=9)

# Legend sheet
lg = wb.create_sheet('מקרא')
lg.sheet_view.rightToLeft = True
lg.column_dimensions['A'].width = 34; lg.column_dimensions['B'].width = 90
rows = [
    ('מה זה', 'טבלת עובדות + דירוגים לכל אתר. אחרי אישור, הבוט ישתמש בה כדי להמליץ באופן מנומק ("טיניי מתאים לכם כי: אתר גבוה עם קרחון, קייטנה בעברית, נציג באתר").'),
    ('לבן', 'עובדה מהאתר הרשמי של האתר (קישור בעמודה "מקור"). אפשר לתקן אם ידוע לכם אחרת.'),
    ('כתום', 'שיפוט טיוטה שלנו (חיי לילה / משפחות) או נתון שאיננו בטוחים בו (יש הערה בתא). נא לאשר או לתקן.'),
    ('צהוב', 'לפינגווין למלא: דירוג 1–5 לכל קהל, רמת תקציב, האם להמליץ, הערות, ו-✓ באישור.'),
    ('דירוג 1–5', '5 = מתאים במיוחד לקהל הזה, 1 = לא מומלץ לקהל הזה. הבוט ימליץ רק על אתרים בדירוג 4–5 לקהל הרלוונטי.'),
    ('תקציב', 'מיצוב יחסי בין האתרים בלבד — הבוט לא יציג מחיר, רק "משתלם/בינוני/פרימיום".'),
    ('להמליץ?', '"לא" = הבוט ידע לענות על שאלות על האתר אבל לא יציע אותו מיוזמתו.'),
    ('מאושר ✓', 'רק שורות עם ✓ נכנסות למנוע ההמלצות. שורות בלי ✓ נשארות טיוטה.'),
    ('שורת דוגמה', 'ראו את השורה של טיניי — מולאה כדוגמה לפורמט (לא מחייב, נא לעדכן).'),
    ('מה לא בטבלה', 'מחירים, שמות מלונות, זמני נסיעה — בכוונה. לפי הכללים האדומים.'),
]
for i, (a, b) in enumerate(rows, 1):
    lg.cell(row=i, column=1, value=a).font = F(bold=True); lg.cell(row=i, column=2, value=b).font = F()
    lg.cell(row=i, column=2).alignment = RIGHT
    fill = {'כתום': DRAFT_FILL, 'צהוב': EDIT_FILL}.get(a)
    if fill: lg.cell(row=i, column=1).fill = fill

# example row: Tignes
rr = HR + 1 + [n for n, _ in order].index('Tignes')
ex = {'מתחילים 1–5': 3, 'משפחות עם ילדים 1–5': 5, 'חבר׳ה צעירים / חיי לילה 1–5': 4, 'גולשים מנוסים 1–5': 5,
      'תקציב (משתלם / בינוני / פרימיום)': 'פרימיום', 'להמליץ? (כן/לא)': 'כן', 'הערות פינגווין': 'דוגמה בלבד — נא לעדכן'}
for h, v in ex.items():
    c = ws[f"{col(h)}{rr}"]; c.value = v; c.font = F(size=10, italic=True, color='7F7F7F')

out = os.path.join(ROOT, 'docs/resort-table.xlsx')
os.makedirs(os.path.dirname(out), exist_ok=True)
wb.save(out)
print(out)

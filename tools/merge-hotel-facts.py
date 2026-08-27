#!/usr/bin/env python3
"""Merge data/hotel-facts.json (verbatim quotes from pingwin.co.il hotel pages) into data/resorts.json as page_facts."""
import json,os
ROOT=os.path.join(os.path.dirname(__file__),'..')
allh=json.load(open(os.path.join(ROOT,'data/hotel-facts.json'),encoding='utf-8'))['hotels']
P=os.path.join(ROOT,'data/resorts.json'); r=json.load(open(P,encoding='utf-8'))
FIELDS=['view_he', 'pool_he', 'shuttle_he', 'location_he', 'center_he', 'restaurant_he', 'kids_he', 'ski_room_he', 'parking_he', 'elevator_he', 'balcony_he', 'renovated_he', 'rooms_features_he', 'notes_he', 'stars_he']
for name,h in r['hotels'].items():
    f=allh.get(name)
    if not f or 'error' in f: continue
    pf={k:f[k] for k in FIELDS if f.get(k)}
    if f.get('lift_he'): pf['lift_page_he']=f['lift_he']
    if f.get('lift_he') and not h.get('lift_he'): h['lift_he']=f['lift_he']
    if f.get('spa_he') and not h.get('spa_he'): h['spa_he']=f['spa_he']
    h['page_facts']=pf
json.dump(r,open(P,'w',encoding='utf-8'),ensure_ascii=False,indent=1)
print('merged',len(r['hotels']))

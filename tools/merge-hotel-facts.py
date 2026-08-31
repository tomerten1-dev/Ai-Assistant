#!/usr/bin/env python3
"""Merge data/hotel-facts.json into data/resorts.json → hotels[*].page_facts.

The bot answers a guest's question about a hotel from `page_facts`, and every
value there is a verbatim quote from that hotel's own page on pingwin.co.il.
This script is the only thing that writes page_facts, so re-running it after a
refresh of hotel-facts.json is all that is needed — nothing else to touch.

Run:  python3 tools/merge-hotel-facts.py
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FACTS = os.path.join(ROOT, 'data', 'hotel-facts.json')
RESORTS = os.path.join(ROOT, 'data', 'resorts.json')

# hotel-facts.json field  ->  page_facts field the bot reads (server/offline-nlu.js)
MAP = {
    'view_he': 'view_he',
    'pool_he': 'pool_he',
    'pool_heated': 'pool_heated',
    'pool_where': 'pool_where',
    'spa_he': 'spa_page_he',        # resorts.json already has its own spa_he
    'location_he': 'location_he',
    'center_he': 'center_he',
    'restaurant_he': 'restaurant_he',
    'kids_he': 'kids_he',
    'ski_room_he': 'ski_room_he',
    'parking_he': 'parking_he',
    'elevator_he': 'elevator_he',
    'balcony_he': 'balcony_he',
    'renovated_he': 'renovated_he',
    'rooms_features_he': 'rooms_features_he',
    'notes_he': 'notes_he',
    'stars_he': 'stars_he',
    'lift_he': 'lift_page_he',
    'shuttle_he': 'shuttle_he',
    'gym_he': 'gym_he',
    'laundry_he': 'laundry_he',
    'wifi_page_he': 'wifi_page_he',
}


def main():
    facts = json.load(open(FACTS, encoding='utf-8'))['hotels']
    resorts = json.load(open(RESORTS, encoding='utf-8'))
    hotels = resorts['hotels']

    merged = 0
    missing = []
    fields = 0
    for name, hotel in hotels.items():
        f = facts.get(name)
        if not f:
            missing.append(name)
            continue
        pf = {}
        for src, dst in MAP.items():
            v = f.get(src)
            if v not in (None, '', []):
                pf[dst] = v
                fields += 1
        hotel['page_facts'] = pf
        merged += 1

    json.dump(resorts, open(RESORTS, 'w', encoding='utf-8'),
              ensure_ascii=False, indent=1)
    print(f'page_facts written for {merged}/{len(hotels)} hotels, {fields} fields')
    if missing:
        print('no facts for:', ', '.join(missing))
    return 0


if __name__ == '__main__':
    sys.exit(main())

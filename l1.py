#!/usr/bin/env python3
"""
Scrape the LinkedIn "About" section for a list of company pages and write
linkedin_companies.csv with Overview, Website, Phone, Verified date, Industry,
Company size, Headquarters, Founded, Specialties.

Usage:
- Put your cookies (exported from browser) in cookies.json in the workspace.
- Create l1.txt with one LinkedIn company URL per line, or edit the DEFAULT_URLS
  list below.
- Run: python l1.py

This script uses requests + BeautifulSoup and targets the exact structure you
provided (section ... h2 'Overview', p.break-words white-space-pre-wrap text-body-medium,
and dl dt/dd pairs inside the same section).
"""

import requests
from bs4 import BeautifulSoup
import csv
import json
import html
import re
import time
import urllib.parse
from pathlib import Path
import os
from datetime import datetime
import pytz
# tqdm for progress bar with a safe fallback if not installed
try:
    from tqdm import tqdm
except Exception:
    class _DummyTqdm:
        def __init__(self, iterable, **kwargs):
            self._iter = iter(iterable)
            self.total = kwargs.get('total')
        def __iter__(self):
            return self
        def __next__(self):
            return next(self._iter)
        def set_postfix(self, *a, **k):
            return
        def update(self, *a, **k):
            return
        def close(self):
            return
    def tqdm(iterable, **kwargs):
        return _DummyTqdm(iterable, **kwargs)


# Placeholder seed used only if l1.txt doesn't exist yet and nothing has fed
# it — unified_scraper.js overwrites this with real discovered company URLs
# as soon as it finds any (see appendToL1Txt in unified_scraper.js).
DEFAULT_URLS = [
    "https://www.linkedin.com/company/linkedin/",
]

OUT_CSV = 'linkedin_companies.csv'
GOOGLE_SHEETS_URL = os.environ.get(
    'GOOGLE_SHEETS_URL',
    'https://script.google.com/macros/s/AKfycbwz28DvEzyPhZh9XsxhGMO1A5YpbFneKeeDmNduW2cp1GVnZuRzZw_xRYOj7TVZ9ZKf/exec'
)


def send_to_sheet(row):
    """Push one scraped row into the 'LinkedInData' sheet tab. Never raises —
    a sheet hiccup shouldn't stop the scrape or the local CSV write."""
    if not row.get('Company Name'):
        return  # nothing usable scraped for this URL, nothing to push
    try:
        payload = {
            'type': 'linkedin',
            'row': '',
            'linkedin_url': row.get('LinkedIn URL', ''),
            'company_name': row.get('Company Name', ''),
            'headline': row.get('Headline', ''),
            'first_subline': row.get('First Subline', ''),
            'second_subline': row.get('Second Subline', ''),
            'website': row.get('Website', ''),
            'overview': row.get('Overview', ''),
            'phone': row.get('Phone', ''),
            'verified': row.get('Verified', ''),
            'industry': row.get('Industry', ''),
            'company_size': row.get('Company Size', ''),
            'headquarters': row.get('Headquarters', ''),
            'org_type': row.get('Type', ''),
            'founded': row.get('Founded', ''),
            'specialties': row.get('Specialties', ''),
            'locations': row.get('Locations', ''),
        }
        r = requests.post(GOOGLE_SHEETS_URL, json=payload, timeout=30)
        data = r.json()
        if not data.get('success'):
            print(f'    ⚠️ Sheet update failed: {data}')
    except Exception as e:
        print(f'    ⚠️ Sheet update error: {e}')


def load_cookies(path='cookies.json'):
    p = Path(path)
    if not p.exists():
        print('cookies.json not found; proceeding without cookies (may not access private pages)')
        return {}
    raw = json.loads(p.read_text(encoding='utf-8'))
    # Support formats: {name: value, ...} OR {'cookies': {name: value}} OR list of cookie dicts
    if isinstance(raw, dict):
        if 'cookies' in raw and isinstance(raw['cookies'], dict):
            return raw['cookies']
        # if values are nested dicts with many keys, try to extract simple mapping
        # detect if values are dicts with 'value' key
        if any(isinstance(v, dict) and 'value' in v for v in raw.values()):
            out = {}
            for k, v in raw.items():
                if isinstance(v, dict) and 'value' in v:
                    out[k] = v.get('value', '')
                else:
                    out[k] = str(v)
            return out
        return raw
    elif isinstance(raw, list):
        out = {}
        for item in raw:
            if isinstance(item, dict) and 'name' in item and 'value' in item:
                out[item['name']] = item.get('value', '')
        return out
    return {}


def load_urls(path='l1.txt'):
    p = Path(path)
    if p.exists():
        lines = [l.strip() for l in p.read_text(encoding='utf-8').splitlines() if l.strip()]
        if lines:
            return lines
    return DEFAULT_URLS


def load_done_urls(csv_path=OUT_CSV):
    """URLs already scraped in a previous run — resume from where it left
    off instead of restarting from the top of l1.txt every time."""
    done = set()
    p = Path(csv_path)
    if not p.exists():
        return done
    try:
        with open(p, newline='', encoding='utf-8') as f:
            for row in csv.DictReader(f):
                url = (row.get('LinkedIn URL') or '').strip()
                if url:
                    done.add(url)
    except Exception:
        pass
    return done


def sanitize(s: str) -> str:
    if not s:
        return ''
    s = html.unescape(s)
    s = re.sub(r'\s+', ' ', s).strip()
    return s


def find_about_section(soup: BeautifulSoup):
    # Try new LinkedIn structure: section[data-test-id="about-us"]
    sec = soup.select_one('section[data-test-id="about-us"]')
    if sec:
        return sec

    # Try older class-based structures: section with class containing org-page-details-module__card-spacing OR org-about-module
    for sec in soup.find_all('section'):
        cls = ' '.join(sec.get('class') or [])
        if 'org-page-details-module__card-spacing' in cls or 'org-about-module' in cls or 'org-page-details' in cls:
            return sec
    # fallback: section that contains an h2 with text 'Overview'
    for sec in soup.find_all('section'):
        if sec.find(['h2', 'h3'], string=re.compile(r'\bOverview\b', re.I)):
            return sec
    # last resort: find any h2 'Overview' and return its parent section
    h2 = soup.find(['h2', 'h3'], string=re.compile(r'\bOverview\b', re.I))
    if h2:
        parent = h2.find_parent('section')
        if parent:
            return parent
    return None


def extract_about_from_section(sec: BeautifulSoup):
    out = {
        'Overview': '',
        'Website': '',
        'Phone': '',
        'Verified': '',
        'Industry': '',
        'Company Size': '',
        'Headquarters': '',
        'Founded': '',
        'Specialties': ''
    }

    # Overview paragraph: prefer data-test-id selector used in recent LinkedIn markup
    overview = ''
    p = sec.select_one('p[data-test-id="about-us__description"]')
    if p and p.get_text(strip=True):
        overview = p.get_text('\n', strip=True)
    else:
        # fallback to old selectors
        p_selectors = [
            'p.break-words.white-space-pre-wrap.text-body-medium',
            'p.break-words.white-space-pre-wrap',
            'p.break-words.text-body-medium',
            'p.break-words',
            'p.white-space-pre-wrap',
            'p.text-body-medium',
            'p'
        ]
        for sel in p_selectors:
            p = sec.select_one(sel)
            if p and p.get_text(strip=True):
                overview = p.get_text('\n', strip=True)
                break
    out['Overview'] = sanitize(overview)

    # dl dt/dd pairs
    # dl dt/dd pairs - prefer data-test-id attributes used by new markup
    # look for dd elements with data-test-id attributes like about-us__website, about-us__industry, etc.
    for key_slug, out_key in (
        ('about-us__website', 'Website'),
        ('about-us__industry', 'Industry'),
        ('about-us__size', 'Company Size'),
        ('about-us__headquarters', 'Headquarters'),
        ('about-us__foundedOn', 'Founded'),
        ('about-us__specialties', 'Specialties')
    ):
        dd = sec.select_one(f'dd[data-test-id="{key_slug}"]')
        if dd and dd.get_text(strip=True):
            out[out_key] = sanitize(dd.get_text(' ', strip=True))

    # fallback to a generic dl parsing for older pages
    dl = sec.find('dl')
    if dl:
        # iterate dt elements
        dts = dl.find_all(['dt', 'h3'])
        for dt in dts:
            key = dt.get_text(' ', strip=True).lower()
            # find next sibling dd or div/p
            val_el = None
            sib = dt.next_sibling
            # walk to element sibling
            while sib and (not getattr(sib, 'name', None)):
                sib = sib.next_sibling
            if sib and getattr(sib, 'name', None):
                if sib.name == 'dd' or sib.name in ('div', 'p', 'span'):
                    val_el = sib
            if not val_el:
                val_el = dt.find_next(['dd', 'div', 'p'])

            val_text = ''
            if val_el:
                # if anchors present, prefer anchors for Website and Phone
                if val_el.find('a', href=True):
                    a = val_el.find('a', href=True)
                    href = a['href'].strip()
                    link_text = a.get_text(' ', strip=True)

                    if 'website' in key:
                        # If the anchor text itself looks like a full URL, prefer it
                        if link_text and link_text.lower().startswith('http'):
                            val_text = link_text
                        # LinkedIn often wraps external sites in a redirect; decode it
                        elif 'redir/redirect' in href or 'redir/redirect?url=' in href:
                            parsed = urllib.parse.urlparse(href)
                            qs = urllib.parse.parse_qs(parsed.query)
                            if 'url' in qs and qs['url']:
                                val_text = urllib.parse.unquote(qs['url'][0])
                            else:
                                # fallback: try to extract url=... manually
                                m = re.search(r'url=([^&]+)', href)
                                if m:
                                    val_text = urllib.parse.unquote(m.group(1))
                                else:
                                    val_text = href
                        else:
                            # if href is already an absolute URL, prefer it; otherwise prefer link text
                            if href.lower().startswith('http'):
                                val_text = href
                            else:
                                val_text = link_text or href
                    elif href.startswith('tel:') and 'phone' in key:
                        val_text = href.replace('tel:', '')
                    else:
                        val_text = link_text or href
                else:
                    val_text = val_el.get_text(' ', strip=True)

            val_text = sanitize(val_text)

            if 'website' in key:
                out['Website'] = val_text
            elif 'phone' in key:
                out['Phone'] = val_text
            elif 'verified' in key or 'verified page' in key:
                out['Verified'] = val_text
            elif 'industry' in key:
                out['Industry'] = val_text
            elif 'company size' in key or key.strip() == 'size':
                out['Company Size'] = val_text
            elif 'headquarter' in key:
                out['Headquarters'] = val_text
            elif 'founded' in key:
                out['Founded'] = val_text
            elif 'specialties' in key:
                # specialties often a comma-separated string
                out['Specialties'] = val_text

    return out


def extract_from_html(html_text: str):
    soup = BeautifulSoup(html_text, 'html.parser')
    sec = find_about_section(soup)
    if sec:
        return extract_about_from_section(sec)
    # fallback: try to find any h2 'Overview' and its following p
    h2 = soup.find(['h2', 'h3'], string=re.compile(r'\bOverview\b', re.I))
    if h2:
        p = h2.find_next('p')
        overview = p.get_text('\n', strip=True) if p else ''
        return {'Overview': sanitize(overview)}
    return {}


def _try_json_load(s: str):
    # Try to parse string as JSON, with a few unescape attempts
    if not s or not isinstance(s, str):
        return None
    tries = [s, html.unescape(s), s.strip("'\" ")]
    for t in tries:
        try:
            return json.loads(t)
        except Exception:
            continue
    return None


def _balanced_json_at(text: str, index: int):
    # Given text and index of a '{', return the substring containing the balanced JSON object
    depth = 0
    start = None
    for i in range(index, len(text)):
        if text[i] == '{':
            if start is None:
                start = i
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0 and start is not None:
                return text[start:i+1]
    return None


def _deep_find(obj, key_fragments):
    # Recursively search dict/list for any key containing one of the key_fragments (lowercased)
    if obj is None:
        return None
    if isinstance(obj, dict):
        for k, v in obj.items():
            kl = k.lower()
            for frag in key_fragments:
                if frag in kl:
                    return v
        for v in obj.values():
            res = _deep_find(v, key_fragments)
            if res is not None:
                return res
    elif isinstance(obj, list):
        for item in obj:
            res = _deep_find(item, key_fragments)
            if res is not None:
                return res
    return None


def extract_from_embedded_json(html_text: str):
    """Try multiple heuristics to locate embedded JSON that contains company fields.
    Returns a dict with possible keys: Overview, Website, Phone, Industry, Company Size,
    Headquarters, Founded, Specialties, Verified
    """
    out = {}
    soup = BeautifulSoup(html_text, 'html.parser')

    # 1) application/ld+json blocks
    for script in soup.find_all('script', type='application/ld+json'):
        txt = script.string or script.get_text(' ', strip=True)
        parsed = _try_json_load(txt)
        if parsed:
            # localizedDescription or description
            desc = _deep_find(parsed, ['localizeddescription', 'description', 'about'])
            if desc:
                out['Overview'] = desc
            web = _deep_find(parsed, ['url', 'website', 'websiteurl'])
            if web:
                out['Website'] = web
            spec = _deep_find(parsed, ['specialties', 'specialities'])
            if spec:
                out['Specialties'] = spec
            ind = _deep_find(parsed, ['industry'])
            if ind:
                out['Industry'] = ind

    # 2) Loose JSON embedded in JS near keys like localizedDescription
    text = html_text
    for m in re.finditer(r'localizedDescription\s*[:=]\s*[{\[]', text, re.I):
        idx = m.start()
        # find first '{' after the match
        brace_idx = text.find('{', idx)
        if brace_idx == -1:
            continue
        cand = _balanced_json_at(text, brace_idx)
        if not cand:
            continue
        parsed = _try_json_load(cand)
        if not parsed:
            continue
        desc = _deep_find(parsed, ['localizeddescription', 'description'])
        if desc:
            out.setdefault('Overview', desc)

    # 3) Search for generic JSON objects that include "website" or "specialties"
    for m in re.finditer(r"\{[^}{]{20,}\}", text):
        cand = m.group(0)
        parsed = _try_json_load(cand)
        if not parsed:
            continue
        if _deep_find(parsed, ['website', 'websiteurl', 'url']):
            web = _deep_find(parsed, ['website', 'websiteurl', 'url'])
            out.setdefault('Website', web)
        if _deep_find(parsed, ['specialties', 'specialities']):
            spec = _deep_find(parsed, ['specialties', 'specialities'])
            out.setdefault('Specialties', spec)
        if _deep_find(parsed, ['localizeddescription', 'description']):
            desc = _deep_find(parsed, ['localizeddescription', 'description'])
            out.setdefault('Overview', desc)
        if _deep_find(parsed, ['industry']):
            out.setdefault('Industry', _deep_find(parsed, ['industry']))

    # Also attempt to extract phone, founded, company size, headquarters, verified
    # search more keys later below
    for k in list(out.keys()):
        v = out[k]
        if isinstance(v, list):
            out[k] = ', '.join([str(x) for x in v if x])
        elif isinstance(v, dict):
            # join dict values
            out[k] = ', '.join([str(x) for x in v.values() if x])
        else:
            out[k] = sanitize(str(v))

    return out



def _find_phone_in_text(text: str):
    # prefer tel: links
    soup = BeautifulSoup(text, 'html.parser')
    for a in soup.find_all('a', href=True):
        href = a['href']
        if href.startswith('tel:'):
            return sanitize(href.replace('tel:', ''))
    # simple phone regex: international or local
    m = re.search(r'(\+?\d[\d\-\s()]{6,}\d)', text)
    if m:
        return sanitize(m.group(1))
    return ''


def _find_founded_in_text(text: str):
    # look for phrases like 'Founded in 2007' or 'Founded 2007' or 'Established in 2007'
    m = re.search(r'Founded\s+(?:in\s+)?(\d{4})', text, re.I)
    if m:
        return m.group(1)
    m = re.search(r'Established\s+(?:in\s+)?(\d{4})', text, re.I)
    if m:
        return m.group(1)
    return ''


def _find_headquarters_in_text(text: str):
    # look for 'Headquartered in X' or 'Our headquarters are in X'
    m = re.search(r'Headquartered in\s+([A-Za-z0-9 ,\-()]+?)(?:\.|,|$)', text, re.I)
    if m:
        return sanitize(m.group(1))
    m = re.search(r'Our headquarters are in\s+([A-Za-z0-9 ,\-()]+?)(?:\.|,|$)', text, re.I)
    if m:
        return sanitize(m.group(1))
    return ''


def _find_company_size_in_text(text: str):
    # common patterns: '150+ employees', '100-200 employees', '1,000 employees'
    m = re.search(r'(\d{1,3}(?:[\,\d]{0,4})(?:\+|\s*[-–]\s*\d{1,4})?)\s+employees', text, re.I)
    if m:
        return sanitize(m.group(1) + ' employees')
    return ''


def extract_top_card_fields(soup: BeautifulSoup):
    """Extract fields from the top card area: Company Name, Headline, First Subline, Second Subline."""
    out = {
        'Company Name': '',
        'Headline': '',
        'First Subline': '',
        'Second Subline': ''
    }
    h1 = soup.select_one('h1.top-card-layout__title')
    if h1 and h1.get_text(strip=True):
        out['Company Name'] = sanitize(h1.get_text(' ', strip=True))
    h2 = soup.select_one('h2.top-card-layout__headline')
    if h2 and h2.get_text(strip=True):
        out['Headline'] = sanitize(h2.get_text(' ', strip=True))
    h3 = soup.select_one('h3.top-card-layout__first-subline')
    if h3 and h3.get_text(strip=True):
        out['First Subline'] = sanitize(h3.get_text(' ', strip=True))
    h4 = soup.select_one('h4.top-card-layout__second-subline')
    if h4:
        span = h4.select_one('span')
        txt = span.get_text(' ', strip=True) if span else h4.get_text(' ', strip=True)
        out['Second Subline'] = sanitize(txt)
    return out


def extract_type_from_about_section(sec: BeautifulSoup):
    if not sec:
        return ''
    dd = sec.select_one('dd[data-test-id="about-us__organizationType"]')
    if dd and dd.get_text(strip=True):
        return sanitize(dd.get_text(' ', strip=True))
    # fallback: search dt text
    dt = sec.find('dt', string=re.compile(r'\bType\b', re.I))
    if dt:
        val = dt.find_next('dd')
        if val and val.get_text(strip=True):
            return sanitize(val.get_text(' ', strip=True))
    return ''


def extract_locations(soup: BeautifulSoup):
    locs = []
    # locate section with class or data-test-id
    for sec in soup.select('section.locations'):
        for li in sec.select('ul.show-more-less__list li'):
            parts = [sanitize(p.get_text(' ', strip=True)) for p in li.select('div[id^="address-"] p') if p.get_text(strip=True)]
            if parts:
                locs.append(', '.join(parts))
    return '; '.join(locs)


RECHECK_INTERVAL = 300  # 5 minutes — unified_scraper.js runs continuously and
                         # keeps appending fresh company URLs to l1.txt, so
                         # this polls for new work instead of exiting once.


def run_batch():
    """Scrape whatever's currently pending in l1.txt. Returns count processed."""
    urls_file = Path('l1.txt')
    if not urls_file.exists():
        # First run ever, nothing feeding it yet — write a starter file so
        # there's something to edit; later runs just wait for l1.txt to
        # reappear (e.g. from unified_scraper.js) instead of recreating it.
        with open(urls_file, 'w', encoding='utf-8') as f:
            for u in DEFAULT_URLS:
                f.write(u + '\n')
        print('Created l1.txt with a starter LinkedIn URL. Edit it, or let unified_scraper.js feed it.')
        return 0

    cookies = load_cookies()
    urls = load_urls()
    done_urls = load_done_urls()
    remaining_urls = [u for u in urls if u not in done_urls]
    if not remaining_urls:
        return 0
    print(f'\n📥 {len(remaining_urls)} URL(s) pending ({len(done_urls)} already done)')

    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9'
    }

    # Open CSV for incremental writes so progress is saved live
    keys = [
        'LinkedIn URL', 'Company Name', 'Headline', 'First Subline', 'Second Subline',
        'Website', 'Overview', 'Phone', 'Verified', 'Industry', 'Company Size', 'Headquarters',
        'Type', 'Founded', 'Specialties', 'Locations', 'Scraped Time', 'SR'
    ]
    out_path = Path(OUT_CSV)
    write_header = True
    if out_path.exists() and out_path.stat().st_size > 0:
        write_header = False

    out_f = open(OUT_CSV, 'a', newline='', encoding='utf-8')
    w = csv.DictWriter(out_f, fieldnames=keys)
    if write_header:
        w.writeheader()
        out_f.flush(); os.fsync(out_f.fileno())

    # iterate with tqdm so we can show progress and assign a numeric SR per row
    pbar = tqdm(remaining_urls, desc='Scraping', unit='page', total=len(remaining_urls))
    for offset, url in enumerate(pbar, start=1):
        sr_num = len(done_urls) + offset
        print(f'Fetching ({sr_num}/{len(urls)}): {url}')
        try:
            r = requests.get(url, headers=headers, cookies=cookies, timeout=1)
            print(f'  status: {r.status_code}, len: {len(r.text)}')
            soup = BeautifulSoup(r.text, 'html.parser')
            top_card = extract_top_card_fields(soup)
            about = extract_from_html(r.text)
            # Try to recover additional fields from embedded JSON/JSON-LD
            try:
                embedded = extract_from_embedded_json(r.text)
            except Exception:
                embedded = {}

            # Merge embedded values into about for any missing fields
            for k, v in embedded.items():
                if k not in about or not about.get(k):
                    about[k] = v

            # If still missing, run light heuristics on the raw HTML
            full_text = r.text
            if not about.get('Phone'):
                phone = _find_phone_in_text(full_text)
                if phone:
                    about['Phone'] = phone
            if not about.get('Founded'):
                founded_v = _find_founded_in_text(full_text)
                if founded_v:
                    about['Founded'] = founded_v
            if not about.get('Headquarters'):
                hq = _find_headquarters_in_text(full_text)
                if hq:
                    about['Headquarters'] = hq
            if not about.get('Company Size'):
                cs = _find_company_size_in_text(full_text)
                if cs:
                    about['Company Size'] = cs
            # New: extract Type and Locations
            sec = find_about_section(soup)
            type_val = extract_type_from_about_section(sec) if sec else ''
            locations_val = extract_locations(soup)

            row = {
                'LinkedIn URL': url,
                'Company Name': top_card.get('Company Name', '') or about.get('name', ''),
                'Headline': top_card.get('Headline', ''),
                'First Subline': top_card.get('First Subline', ''),
                'Second Subline': top_card.get('Second Subline', ''),
                'Website': about.get('Website', ''),
                'Overview': about.get('Overview', ''),
                'Phone': about.get('Phone', ''),
                'Verified': about.get('Verified', ''),
                'Industry': about.get('Industry', ''),
                'Company Size': about.get('Company Size', ''),
                'Headquarters': about.get('Headquarters', ''),
                'Type': type_val,
                'Founded': about.get('Founded', ''),
                'Specialties': about.get('Specialties', ''),
                'Locations': locations_val
            }
            # write the row immediately and flush to disk; add Scraped Time and numeric SR
            ist = pytz.timezone('Asia/Kolkata')
            row['Scraped Time'] = datetime.now(ist).strftime('%Y-%m-%d %H:%M:%S %Z')
            row['SR'] = sr_num
            w.writerow(row)
            out_f.flush(); os.fsync(out_f.fileno())
            send_to_sheet(row)
            # update progress bar with status
            try:
                pbar.set_postfix({'sr': sr_num, 'status': r.status_code})
            except Exception:
                pass
        except Exception as e:
            print('  Error:', e)
            # write an error row so progress is recorded
            ist = pytz.timezone('Asia/Kolkata')
            err_row = {'LinkedIn URL': url, 'Company Name': '', 'Website': '', 'Overview': '', 'Phone': '', 'Verified': '', 'Industry': '', 'Company Size': '', 'Headquarters': '', 'Founded': '', 'Specialties': '', 'Scraped Time': datetime.now(ist).strftime('%Y-%m-%d %H:%M:%S %Z'), 'SR': sr_num}
            w.writerow(err_row)
            out_f.flush(); os.fsync(out_f.fileno())

        time.sleep(1)
    out_f.close()
    print(f'Appended rows to {OUT_CSV}')
    return len(remaining_urls)


def main():
    print(f'🔗 l1.py — watching l1.txt every {RECHECK_INTERVAL // 60} min for new LinkedIn URLs (Ctrl+C to stop)\n')
    try:
        while True:
            count = run_batch()
            if count:
                print(f'\n✅ Processed {count} URL(s) this cycle.')
            else:
                print('😴 Nothing new to scrape.', end=' ')
            print(f'Checking again in {RECHECK_INTERVAL // 60} min...\n')
            time.sleep(RECHECK_INTERVAL)
    except KeyboardInterrupt:
        print('\n⏸ Stopped by user.')


if __name__ == '__main__':
    main()

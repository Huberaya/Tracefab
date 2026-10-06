import re

with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# 1. Update CSS tokens for high-end Bento, ultra-soft shadows, and floating pills
old_css_needle = ':root {'
new_css_tokens = ''':root {
      /* New Modern B2B Bento & Elevated Dashboard Tokens */
      --tf-canvas-gradient: radial-gradient(circle at 50% -10%, rgba(11, 118, 86, 0.08) 0%, transparent 60%),
                            radial-gradient(circle at 90% 20%, rgba(16, 185, 129, 0.04) 0%, transparent 40%),
                            #f8faf9;
      --tf-bento-bg: #ffffff;
      --tf-bento-border: #e8eee9;
      --tf-bento-shadow: 0 10px 30px -5px rgba(7, 24, 18, 0.04), 0 4px 12px rgba(7, 24, 18, 0.02);
'''
if '--tf-canvas-gradient' not in html:
    html = html.replace(old_css_needle, new_css_tokens + old_css_needle)

# 2. Add Floating Pill Navigation in the Mockup Chrome bar (inspired by Image 3)
old_mockup_chrome = '''<div class="mockup-url-pill">
              <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/></svg>
              app.tracefab.com/workspace/atelier-demo
            </div>'''

new_mockup_chrome = '''<div style="display:flex;background:#eef2ef;padding:3px;border-radius:30px;gap:2px;">
              <span style="background:#07120e;color:#ffffff;font-size:11px;font-weight:700;padding:4px 14px;border-radius:20px;box-shadow:0 2px 6px rgba(0,0,0,0.15);">Overview</span>
              <span style="color:#61726a;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;">Supply Chain</span>
              <span style="color:#61726a;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;">Quality</span>
              <span style="color:#61726a;font-size:11px;font-weight:600;padding:4px 12px;border-radius:20px;">DPP</span>
            </div>'''
if old_mockup_chrome in html:
    html = html.replace(old_mockup_chrome, new_mockup_chrome)

# 3. Add Live Network Operations Strip in Hero Mockup (inspired by Image 1)
old_header_strip = '''<div class="mockup-header-strip">
                <div class="mockup-title">
                  <h3>Supply Chain Cockpit</h3>
                  <span>Atelier Demo · Fall Collection 2026</span>
                </div>
                <div style="display:flex;gap:6px;">
                  <span class="badge badge-verified">94.2% Documented</span>
                </div>
              </div>'''

new_header_strip = '''<div style="display:flex;justify-content:space-between;align-items:center;background:#ffffff;padding:12px 16px;border-radius:14px;border:1px solid #e8ede9;box-shadow:0 2px 8px rgba(0,0,0,0.02);margin-bottom:12px;">
                <div>
                  <div style="font-size:10px;font-weight:750;text-transform:uppercase;letter-spacing:0.08em;color:var(--tf-emerald-500);">Live Supply Chain Network</div>
                  <h4 style="font-size:15px;font-weight:800;color:var(--tf-text-title);margin-top:1px;">Atelier Demo — FW26 Master Collection</h4>
                </div>
                <div style="display:flex;align-items:center;gap:10px;">
                  <span style="display:inline-flex;align-items:center;gap:6px;background:#eaf5ef;color:#0b7656;font-size:11px;font-weight:700;padding:4px 10px;border-radius:20px;">
                    <span style="width:6px;height:6px;border-radius:50%;background:#10b981;"></span>
                    1,284 lots tracked
                  </span>
                  <a href="/brand-console/?demo=1" class="btn btn-dark btn-sm" style="font-size:11px;padding:5px 11px;border-radius:8px;">+ New Shipment Lot</a>
                </div>
              </div>'''
if old_header_strip in html:
    html = html.replace(old_header_strip, new_header_strip)

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print("Updated index.html successfully with reference styles.")

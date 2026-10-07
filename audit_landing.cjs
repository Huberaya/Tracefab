const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();
for(const [tag,w,h] of [['desktop',1440,900],['mobile',390,844]]){
  const ctx=await b.newContext({viewport:{width:w,height:h}}); const p=await ctx.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message.slice(0,95)));
  p.on('console',m=>{if(m.type()==='error')errs.push(m.text().slice(0,95));});
  await p.goto('http://127.0.0.1:3000/',{waitUntil:'networkidle',timeout:30000});
  await p.waitForTimeout(1500);
  const r=await p.evaluate((H)=>{
    const s=[...document.querySelectorAll('section,header,footer')].map(e=>{const b=e.getBoundingClientRect();
      return {id:e.id||e.className.split(' ')[0],y:Math.round(b.top+window.scrollY),h:Math.round(b.height)};});
    const vis=[...document.querySelectorAll('a,button')].filter(e=>{const b=e.getBoundingClientRect();
      return b.top<H&&b.bottom>0&&b.width>0;});
    return {sections:s, hauteur:document.documentElement.scrollHeight,
      of:document.documentElement.scrollWidth-document.documentElement.clientWidth,
      h1:(document.querySelector('h1')||{}).innerText,
      ctaHaut:vis.filter(e=>!e.closest('nav,header')).map(e=>e.innerText.trim()).filter(Boolean),
      svg:document.querySelectorAll('svg').length, canvas:document.querySelectorAll('canvas').length,
      img:document.querySelectorAll('img').length,
      anim:[...document.querySelectorAll('*')].filter(e=>{const c=getComputedStyle(e);
        return c.animationName!=='none'||c.transitionProperty!=='all'&&c.transitionDuration!=='0s';}).length};},h);
  console.log('  ['+tag+'] page '+r.hauteur+'px, debord '+r.of+'px, svg='+r.svg+' canvas='+r.canvas+' img='+r.img);
  console.log('     h1 : '+JSON.stringify((r.h1||'').replace(/\n/g,' / ')));
  console.log('     CTA au-dessus de la ligne : '+JSON.stringify(r.ctaHaut));
  r.sections.forEach(s=>console.log('       '+String(s.y).padStart(5)+' +'+String(s.h).padStart(4)+'  '+s.id));
  if(errs.length) console.log('     ERREURS '+errs.slice(0,3).join(' | '));
  await p.screenshot({path:'.visual/landing-'+tag+'.png',fullPage:true});
  await ctx.close();
}
await b.close()})().catch(e=>console.log('  ERREUR',e.message.slice(0,200)));

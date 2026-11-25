/* Extraction vectorielle d'un PDF de plan (pdf.js) : trame, limites bleues, empreinte, colonnes. Coordonnées PDF (pt, y vers le haut). */
const hex=h=>{ if(typeof h!=='string'||h[0]!=='#') return null; const n=parseInt(h.slice(1),16); return [(n>>16)&255,(n>>8)&255,n&255]; };
const mm=(a,m)=>[m[0]*a[0]+m[2]*a[1]+m[4], m[1]*a[0]+m[3]*a[1]+m[5]];
const mul=(a,b)=>[a[0]*b[0]+a[1]*b[2],a[0]*b[1]+a[1]*b[3],a[2]*b[0]+a[3]*b[2],a[2]*b[1]+a[3]*b[3],a[4]*b[0]+a[5]*b[2]+b[4],a[4]*b[1]+a[5]*b[3]+b[5]];
const near=(c,r,g,b,t=40)=>c&&Math.abs(c[0]-r)<=t&&Math.abs(c[1]-g)<=t&&Math.abs(c[2]-b)<=t;
const med=a=>{ const s=a.slice().sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };

export async function extractPdf(pdfjs,data,pageNo=1){
  const doc=await pdfjs.getDocument({data:new Uint8Array(data),verbosity:0}).promise;
  const pg=await doc.getPage(pageNo), view=pg.view, O=pdfjs.OPS;
  const out={page:{w:view[2]-view[0],h:view[3]-view[1],n:doc.numPages,no:pageNo},grid:{x:[],y:[]},limits:[],foot:[],cols:[],scaleHint:null,warn:[]};
  // 1. annotations Bluebeam (lignes)
  const an=await pg.getAnnotations(); const lim=[];
  an.forEach(a=>{ if(a.subtype!=='Line'||!a.lineCoordinates||!a.color) return; const c=[a.color[0],a.color[1],a.color[2]];
    const isB=near(c,0,128,255,40), isP=near(c,128,0,255,40); if(!isB&&!isP) return;
    const [x0,y0,x1,y1]=a.lineCoordinates;
    if(Math.abs(x0-x1)<1.5) lim.push({o:'V',pos:(x0+x1)/2,a:Math.min(y0,y1),b:Math.max(y0,y1),c:isB?'b':'p'});
    else if(Math.abs(y0-y1)<1.5) lim.push({o:'H',pos:(y0+y1)/2,a:Math.min(x0,x1),b:Math.max(x0,x1),c:isB?'b':'p'});
    else out.warn.push('ligne bleue oblique ignorée'); });
  // 2. contenu de page (sans annotations)
  const ol=await pg.getOperatorList({annotationMode:pdfjs.AnnotationMode?pdfjs.AnnotationMode.DISABLE:0});
  let ctm=[1,0,0,1,0,0], st=[], sc=[0,0,0], fc=[0,0,0], lw=1, dash=false;
  const segs=[], fills=[];
  const paint=(po,P)=>{ // P: sous-chemins [[pts],closed]
    const doS=[O.stroke,O.closeStroke,O.fillStroke,O.eoFillStroke,O.closeFillStroke,O.closeEOFillStroke].includes(po);
    const doF=[O.fill,O.eoFill,O.fillStroke,O.eoFillStroke,O.closeFillStroke,O.closeEOFillStroke].includes(po);
    P.forEach(sp=>{ const pts=sp.p; if(pts.length<2) return;
      if(doS){ for(let i=0;i<pts.length-1;i++) segs.push({x1:pts[i][0],y1:pts[i][1],x2:pts[i+1][0],y2:pts[i+1][1],c:sc,w:lw*Math.hypot(ctm[0],ctm[1]),d:dash});
        if(sp.cl&&pts.length>2) segs.push({x1:pts[pts.length-1][0],y1:pts[pts.length-1][1],x2:pts[0][0],y2:pts[0][1],c:sc,w:lw*Math.hypot(ctm[0],ctm[1]),d:dash}); }
      if(doF){ const xs=pts.map(p=>p[0]), ys=pts.map(p=>p[1]); const x0=Math.min(...xs),x1=Math.max(...xs),y0=Math.min(...ys),y1=Math.max(...ys);
        const isRect=pts.length>=4&&pts.length<=5&&pts.every(p=>(Math.abs(p[0]-x0)<0.05||Math.abs(p[0]-x1)<0.05)&&(Math.abs(p[1]-y0)<0.05||Math.abs(p[1]-y1)<0.05));
        if(isRect) fills.push({x:x0,y:y0,w:x1-x0,h:y1-y0,c:fc}); } }); };
  for(let i=0;i<ol.fnArray.length;i++){ const f=ol.fnArray[i], a=ol.argsArray[i];
    if(f===O.save) st.push([ctm.slice(),sc,fc,lw,dash]);
    else if(f===O.restore){ const s=st.pop(); if(s){ [ctm,sc,fc,lw,dash]=s; } }
    else if(f===O.transform) ctm=mul(a,ctm);
    else if(f===O.setStrokeRGBColor) sc=hex(a[0])||sc;
    else if(f===O.setFillRGBColor) fc=hex(a[0])||fc;
    else if(f===O.setLineWidth) lw=a[0];
    else if(f===O.setDash) dash=!!(a[0]&&a[0].length);
    else if(f===O.constructPath){ const po=a[0], d=(a[1]&&(Array.isArray(a[1][0])||ArrayBuffer.isView(a[1][0])))?a[1][0]:a[1]; const P=[]; let cur=null, k=0;
      while(k<d.length){ const code=d[k++];
        if(code===0){ cur={p:[mm([d[k],d[k+1]],ctm)],cl:false}; P.push(cur); k+=2; }
        else if(code===1){ if(!cur){ cur={p:[],cl:false}; P.push(cur); } cur.p.push(mm([d[k],d[k+1]],ctm)); k+=2; }
        else if(code===2){ if(cur) cur.p.push(mm([d[k+4],d[k+5]],ctm)); k+=6; }
        else if(code===3){ if(cur) cur.p.push(mm([d[k+2],d[k+3]],ctm)); k+=4; }
        else if(code===4){ if(cur){ cur.cl=true; if(cur.p.length>2) cur.p.push(cur.p[0].slice()); } }
        else break; }
      paint(po,P); } }
  // limites : annotations, sinon traits bleus pointillés du contenu
  if(lim.length) out.limits=lim;
  else segs.filter(s=>s.d&&near(s.c,0,128,255,40)||s.d&&near(s.c,128,0,255,40)).forEach(s=>{
    if(Math.abs(s.x1-s.x2)<1.5) out.limits.push({o:'V',pos:(s.x1+s.x2)/2,a:Math.min(s.y1,s.y2),b:Math.max(s.y1,s.y2),c:'b'});
    else if(Math.abs(s.y1-s.y2)<1.5) out.limits.push({o:'H',pos:(s.y1+s.y2)/2,a:Math.min(s.x1,s.x2),b:Math.max(s.x1,s.x2),c:'b'}); });
  // empreinte : traits gris pleins orthogonaux
  segs.forEach(s=>{ if(s.d||!(near(s.c,171,171,171,25))) return; const len=Math.hypot(s.x2-s.x1,s.y2-s.y1); if(len<4) return;
    out.foot.push([+s.x1.toFixed(2),+s.y1.toFixed(2),+s.x2.toFixed(2),+s.y2.toFixed(2)]); }); // orthogonaux et obliques (les limites SAFE n'utilisent que les orthogonaux)
  // styles de traits (couleur, épaisseur, pointillé) : sert à choisir l'empreinte dans l'outil
  const SM={}; segs.forEach(q=>{ const len=Math.hypot(q.x2-q.x1,q.y2-q.y1); if(len<1) return; const c=q.c.map(Math.round), w=+q.w.toFixed(2), k=c.join(',')+'|'+w+'|'+(q.d?'d':'p');
    const g=SM[k]||(SM[k]={k,c,w,d:!!q.d,n:0,len:0,segs:[]}); g.n++; g.len+=len; if(g.segs.length<4000) g.segs.push([+q.x1.toFixed(2),+q.y1.toFixed(2),+q.x2.toFixed(2),+q.y2.toFixed(2)]); });
  out.styles=Object.values(SM).filter(g=>g.len>=30).sort((p,q)=>q.len-p.len);
  // colonnes : rectangles remplis de taille plausible
  const seen=new Set();
  fills.forEach(r=>{ if(!near(r.c,170,170,170,25)) return; if(r.w<6||r.h<6||r.w>45||r.h>45) return;
    const k=Math.round((r.x+r.w/2)/2)+'|'+Math.round((r.y+r.h/2)/2); if(seen.has(k)) return; seen.add(k); out.cols.push({x:r.x+r.w/2,y:r.y+r.h/2,w:r.w,h:r.h}); });
  // 3. trame : étiquettes de bulles appariées (aux deux extrémités d'un axe)
  const tc=await pg.getTextContent(); const L={};
  tc.items.forEach(it=>{ const s=(it.str||'').trim(); if(!/^([A-Z]{1,2}|\d{1,3})$/.test(s)) return; const t=it.transform;
    (L[s]=L[s]||[]).push([t[4]+it.width/2, t[5]+Math.abs(t[3])*0.35]); });
  const red=segs.filter(s=>!s.d||true).filter(s=>near(s.c,255,0,0,40));
  const gx=[], gy=[];
  Object.keys(L).forEach(l=>{ const P=L[l]; if(P.length<2) return;
    for(let i=0;i<P.length;i++) for(let j=i+1;j<P.length;j++){ const dx=Math.abs(P[i][0]-P[j][0]), dy=Math.abs(P[i][1]-P[j][1]);
      if(dx<4&&dy>200){ gx.push({l,pos:(P[i][0]+P[j][0])/2,ext:[Math.min(P[i][1],P[j][1]),Math.max(P[i][1],P[j][1])]}); return; }
      if(dy<4&&dx>200){ gy.push({l,pos:(P[i][1]+P[j][1])/2,ext:[Math.min(P[i][0],P[j][0]),Math.max(P[i][0],P[j][0])]}); return; } } });
  // affinage avec les traits rouges de la trame
  gx.forEach(g=>{ const c=red.filter(s=>Math.abs(s.x1-s.x2)<0.3&&Math.abs(s.x1-g.pos)<9&&Math.min(s.y1,s.y2)>g.ext[0]&&Math.max(s.y1,s.y2)<g.ext[1]).map(s=>s.x1); if(c.length>=3){ const m=med(c); if(Math.abs(m-g.pos)<1.5){ g.pos=m; g.refined=true; } } });
  gy.forEach(g=>{ const c=red.filter(s=>Math.abs(s.y1-s.y2)<0.3&&Math.abs(s.y1-g.pos)<9&&Math.min(s.x1,s.x2)>g.ext[0]&&Math.max(s.x1,s.x2)<g.ext[1]).map(s=>s.y1); if(c.length>=3){ const m=med(c); if(Math.abs(m-g.pos)<1.5){ g.pos=m; g.refined=true; } } });
  const dedupe=a=>{ const m={}; a.forEach(g=>{ if(!m[g.l]) m[g.l]=g; }); return Object.values(m).sort((p,q)=>p.pos-q.pos); };
  out.grid.x=dedupe(gx); out.grid.y=dedupe(gy);
  // échelle d'après le texte « 1/8" = 1'-0" » (indice)
  const txt=tc.items.map(i=>i.str).join(' ');
  const m=txt.match(/(\d+\/\d+|\d+)\s*"\s*=\s*1'/); if(m){ const q=m[1].includes('/')?eval(m[1]):+m[1]; out.scaleHint={label:m[1]+'" = 1\'-0"',mPerPt:(1/72)/q*0.3048}; }
  return out;
}

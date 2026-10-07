// Drawn from the supplied reference using only Artboard's validated primitives.
// No source bitmap, sprites, alternate palette, or image-generation model.
export default async function draw(tools, args) {
  const reviewed = args.includes('reviewed');
  const scene_id = reviewed ? 'fighter-reviewed' : 'fighter-first-shot';
  const width = 641, height = 568;
  await tools.scene_create({ scene_id, width, height, seed: 7102026 });
  const objects = [];
  let serial = 0;
  const add = (kind, geometry, style = {}, layer = 0) => {
    objects.push({ id: `shape${String(++serial).padStart(3, '0')}`, kind, layer, ...geometry, ...style });
  };
  const poly = (points, color, layer, extra = {}) => {
    if(reviewed && layer===37) return tone(points,'dark gray','black',0.20,layer);
    add('polygon', { points }, { color, ...extra }, layer);
  };
  const line = (points, color, layer, stroke_width = 1) => add('line', { points }, { color, stroke_width }, layer);
  // Ordered dither is the existing sky material, projectively mapped to give
  // small shapes an almost constant blend without introducing new colors.
  const twoTone = (points, foreground, background, coverage, layer) => {
    const top = Math.min(...points.map(p => p[1])) - coverage / 0.65 * 2000;
    add('polygon', { points, mapping: { quad: [[0,top],[1000,top],[1000,top+2000],[0,top+2000]], size: [1000,2000] } }, {
      material: { id: 'sky', params: { variant: 'dither', foreground, background, scale: 1 } },
    }, layer);
  };
  // Geometry clipping gives the second pass three- and four-color optical
  // mixtures. Every stripe remains an ordinary validated line object.
  const stripes = (points, color, spacing, vertical, layer) => {
    const shape=vertical?points.map(([x,y])=>[y,x]):points;
    const low=Math.max(0,Math.ceil(Math.min(...shape.map(p=>p[1]))));
    const high=Math.min(vertical?width:height,Math.ceil(Math.max(...shape.map(p=>p[1]))));
    let path=[];
    const flush=()=>{ if(path.length>=2) line(path,color,layer); path=[]; };
    for(let y=low+(spacing-low%spacing)%spacing;y<high;y+=spacing) {
      const crossings=[];
      for(let i=0;i<shape.length;i++) {
        const a=shape[i],b=shape[(i+1)%shape.length],py=y+0.5;
        if((a[1]<=py&&b[1]>py)||(b[1]<=py&&a[1]>py)) crossings.push(a[0]+(py-a[1])*(b[0]-a[0])/(b[1]-a[1]));
      }
      crossings.sort((a,b)=>a-b);
      for(let i=0;i+1<crossings.length;i+=2) {
        let ends=[[Math.ceil(crossings[i]),y],[Math.floor(crossings[i+1]),y]];
        if(ends[1][0]<ends[0][0]) continue;
        if((y/spacing|0)%2) ends.reverse();
        if(vertical) ends=ends.map(([x,y])=>[y,x]);
        if(path.length+2>256) flush();
        path.push(...ends);
      }
    }
    flush();
  };
  const tone = (points, foreground, background, coverage, layer) => {
    if(!reviewed || layer>8) return twoTone(points,foreground,background,coverage,layer);
    if(layer<=3) {
      twoTone(points,'light gray','white',layer===0?0.27:0.40,layer);
      stripes(points,'blue',layer===0?4:6,true,layer);
      stripes(points,'dark cyan',layer===0?5:8,false,layer);
    } else if(layer<=5) {
      twoTone(points,'light gray','white',layer===4?0.03:0.15,layer);
      stripes(points,'blue',5,true,layer);
      stripes(points,'dark cyan',6,false,layer);
    } else if(layer<=7) {
      twoTone(points,'light gray','dark gray',layer===6?0.14:0.34,layer);
      stripes(points,'blue',7,true,layer);
      stripes(points,'dark cyan',8,false,layer);
    } else twoTone(points,'light gray','dark gray',0.28,layer);
  };
  const ovalPoints = (cx, cy, rx, ry, angle = 0, count = 28) => Array.from({ length: count }, (_, i) => {
    const a = i * Math.PI * 2 / count, r = angle * Math.PI / 180;
    return [cx + Math.cos(a)*rx*Math.cos(r) - Math.sin(a)*ry*Math.sin(r), cy + Math.cos(a)*rx*Math.sin(r) + Math.sin(a)*ry*Math.cos(r)];
  });
  const oval = (cx, cy, rx, ry, angle, color, layer) => poly(ovalPoints(cx,cy,rx,ry,angle), color, layer);
  let state = 7102026;
  const random = () => { state = (Math.imul(state,1664525)+1013904223) >>> 0; return state/4294967296; };
  const ribbon = (x, y, length, thickness, angle, phase = 0) => {
    const r = angle*Math.PI/180, top = [], bottom = [];
    for (let i=0; i<=16; i++) {
      const t=i/16, swell=Math.sin(Math.PI*t)**0.7;
      const u=t*length, v=Math.sin(t*8+phase)*thickness*0.4;
      top.push([x+u*Math.cos(r)-(v-swell*thickness/2)*Math.sin(r),y+u*Math.sin(r)+(v-swell*thickness/2)*Math.cos(r)]);
      bottom.push([x+u*Math.cos(r)-(v+swell*thickness/2)*Math.sin(r),y+u*Math.sin(r)+(v+swell*thickness/2)*Math.cos(r)]);
    }
    return top.concat(bottom.reverse());
  };

  // Pale blue atmosphere and the banking camera's diagonal cloud strata.
  for (let band=0;band<12;band++) {
    const y=band*48;
    tone([[0,y],[width,y],[width,y+48],[0,y+48]], 'light gray','blue',0.32-band*0.016,0);
  }
  const scanlines = [];
  for (let y=2;y<360;y+=8) {
    if ((y/8|0)%2) scanlines.push([0,y],[641,y]);
    else scanlines.push([641,y],[0,y]);
  }
  if(!reviewed) line(scanlines,'dark cyan',1);
  const haze = [];
  for (let y=197;y<568;y+=8) {
    if ((y/8|0)%2) haze.push([0,y],[641,y]);
    else haze.push([641,y],[0,y]);
  }
  if(!reviewed) line(haze,'white',1);
  const clouds = [
    [-70,249,440,32,-27],[-28,303,610,47,-29],[-40,348,770,42,-27],
    [73,188,510,22,-25],[198,141,500,18,-23],[374,74,310,28,-24],
    [316,196,470,32,-27],[-98,450,760,49,-29],[23,371,760,27,-27],
    [-119,178,365,34,-28],[1,401,756,31,-26],
  ];
  for (const [index,c] of clouds.entries()) {
    const parameters=[...c];
    if(reviewed) parameters[3]*=0.45;
    tone(ribbon(...parameters,index), 'light gray','white',index%3===0?0.25:0.13,2);
  }
  for (let i=0;i<24;i++) {
    const x=-60+random()*650,y=150+random()*370,l=24+random()*150;
    tone(ribbon(x,y,l,2+random()*5,-27,random()*6), 'light gray','white',0.26,3);
  }

  // Three mountain distances. Their silhouettes follow the tilted reference.
  const far = [[70,568],[117,509],[151,495],[171,477],[212,473],[242,438],[286,421],[355,408],[412,385],[454,370],[500,321],[535,285],[565,258],[583,260],[606,269],[641,252],[641,568]];
  tone(far,'light gray','blue',0.40,4);
  const ridge = [[79,568],[122,525],[153,486],[186,484],[215,455],[233,434],[273,423],[308,420],[342,408],[383,410],[416,397],[454,388],[486,370],[520,369],[549,350],[582,357],[613,346],[641,344],[641,568]];
  tone(ridge,'light gray','dark gray',0.24,6);
  const distantFacets = [
    [[486,370],[535,285],[565,258],[558,293],[535,304],[529,338]],
    [[565,258],[585,262],[597,292],[578,322],[570,304],[553,341],[555,297]],
    [[585,265],[613,276],[607,311],[600,335],[586,351],[602,289]],
    [[613,271],[641,252],[641,302],[623,327],[627,288]],
    [[499,358],[529,334],[530,351],[514,369]],
  ];
  for(const f of distantFacets) tone(f,'light gray','blue',0.28,5);
  const mountainRegions = [
    [[133,568],[162,526],[198,509],[231,471],[261,448],[298,437],[271,480],[245,511],[224,542],[203,568]],
    [[205,568],[246,511],[274,484],[301,465],[337,439],[368,425],[351,460],[323,490],[307,526],[277,568]],
    [[292,568],[323,527],[353,510],[381,480],[418,445],[448,419],[457,400],[483,392],[467,425],[443,452],[413,500],[382,539],[359,568]],
    [[386,568],[418,523],[448,501],[475,466],[505,446],[532,404],[556,384],[584,374],[564,415],[553,449],[512,500],[474,545],[445,568]],
    [[471,568],[509,536],[539,514],[553,486],[581,469],[608,426],[626,393],[641,379],[641,568]],
  ];
  for(const f of mountainRegions) tone(f,'dark gray','blue',0.25,7);
  // Broken rock faces, gullies and sparse gray scree, rather than regular tiles.
  for(let i=0;i<120;i++) {
    const x=150+random()*500, y=420+random()*160;
    const horizon=492-(x-150)*0.27;
    if(y<horizon) continue;
    const size=2+random()*8, rise=3+random()*9;
    const face=[[x,y],[x+size*0.65,y-rise],[x+size,y-rise*0.55],[x+size*1.45,y+size*0.45],[x+size*0.4,y+size*0.85]];
    tone(face,i%3===0?'white':'light gray',i%2?'dark gray':'blue',0.25,8);
  }
  for(let i=0;i<44;i++) {
    const x=235+random()*420,y=410+random()*155;
    if(y<481-(x-150)*0.25) continue;
    line([[x,y],[x-3,y+5],[x-6,y+9],[x-8,y+15]],i%4===0?'light gray':'dark gray',9);
  }
  // A winding pale road in the right-hand foreground valley.
  line([[641,435],[628,440],[625,451],[618,458],[611,461],[609,470],[601,476],[594,480],[589,483],[584,482],[581,474],[575,470],[571,474],[566,484],[557,491],[548,493],[538,490],[531,484],[528,477]],'light gray',10,3);
  line([[641,437],[631,444],[629,454],[620,462],[615,464]],'dark gray',11);

  // Fighter: far-side pylons and stabilizers, behind the fuselage.
  poly([[163,269],[192,265],[254,265],[286,273],[251,285],[194,290],[176,281]],'dark gray',20);
  tone([[169,270],[206,269],[244,264],[252,272],[225,280],[188,285]],'light gray','dark gray',0.40,21);
  poly([[201,253],[209,246],[229,269],[214,280]],'dark gray',22);
  poly([[201,251],[209,246],[224,265],[215,270]],'light gray',23);
  line([[208,249],[217,266]],'dark gray',24);
  poly([[174,275],[201,276],[214,288],[194,294],[178,286]],'dark gray',24);
  poly([[205,268],[257,267],[293,278],[251,292],[214,288]],'light gray',25);
  tone([[211,269],[256,268],[281,276],[253,281],[227,279]],'light gray','dark gray',0.25,26);

  // Far wingtip missile, oriented forward along the aircraft's axis.
  const missile = (x,y,length,size,layer) => {
    const a=-25*Math.PI/180, p=(u,v)=>[x+u*Math.cos(a)-v*Math.sin(a),y+u*Math.sin(a)+v*Math.cos(a)];
    poly([p(-3,0),p(4,-size*0.7),p(length-4,-size*0.55),p(length,0),p(length-5,size*0.6),p(2,size*0.7)],'dark gray',layer);
    poly([p(4,-size*0.6),p(length-5,-size*0.55),p(length-1,0),p(6,0)],'light gray',layer+1);
    poly([p(3,-1),p(-5,-size*1.7),p(0,-size*1.7),p(10,1)],'dark gray',layer+2);
    poly([p(4,1),p(0,size*1.9),p(5,size*1.6),p(13,0)],'dark gray',layer+2);
    line([p(11,-size*0.45),p(length-8,-size*0.4)],'white',layer+3);
    oval(...p(length-3,0),3,size*0.55,-25,'light gray',layer+3);
  };
  missile(147,275,42,3.0,27);
  missile(179,288,34,2.8,27);

  // Vertical tail and rear fuselage.
  poly([[230,288],[253,279],[271,255],[278,256],[297,277],[311,282],[279,296],[248,306]],'dark gray',32);
  tone([[246,284],[271,255],[278,256],[291,275],[271,287]],'light gray','dark gray',0.35,33);
  line([[274,259],[283,274],[270,277]],'dark gray',34);
  poly([[224,291],[249,279],[279,275],[319,262],[348,247],[389,231],[419,221],[445,217],[467,217],[469,224],[448,238],[422,246],[398,258],[366,275],[332,291],[294,306],[257,317],[238,315],[224,304]],'dark gray',35);
  tone([[231,290],[255,281],[289,272],[329,255],[357,242],[392,229],[422,221],[446,218],[461,218],[447,228],[408,241],[367,257],[323,278],[279,292],[249,303]],'light gray','dark gray',0.30,36);
  poly([[225,301],[243,308],[278,299],[314,283],[354,270],[395,257],[417,244],[398,260],[359,280],[320,297],[277,313],[252,318],[237,316]],'black',37);
  tone([[240,302],[269,293],[312,278],[355,261],[396,247],[415,242],[397,258],[356,276],[313,293],[276,306],[251,310]],'dark gray','black',0.23,38);

  // Engine exhaust and tail detail.
  poly([[223,295],[229,289],[244,287],[252,295],[249,306],[237,315],[228,312],[223,305]],'black',39);
  tone([[224,295],[230,290],[239,290],[240,302],[231,310],[225,306]],'dark gray','black',0.20,40);
  line([[227,294],[232,300],[229,309]],'light gray',41);
  poly([[243,309],[260,305],[256,318],[248,319]],'dark gray',42);

  // Main swept wing, seen partly from below, extending right across the image.
  poly([[275,284],[308,269],[365,254],[392,259],[386,270],[363,281],[312,301],[278,312],[269,306]],'dark gray',43);
  tone([[280,285],[314,271],[366,257],[384,260],[357,277],[309,295],[280,303]],'light gray','dark gray',0.50,44);
  poly([[285,302],[320,289],[364,277],[377,271],[366,285],[320,300],[287,314],[274,310]],'dark gray',45);
  line([[294,288],[345,271],[364,261]],'light gray',46);
  poly([[284,307],[288,314],[293,315],[289,323],[275,322],[275,314]],'dark gray',47);

  // Belly air intake and upper-facing inlet lip; the inside remains black.
  poly([[267,275],[282,268],[302,266],[310,270],[307,279],[294,290],[279,296],[269,289]],'black',48);
  tone([[269,274],[282,270],[300,267],[308,270],[296,276],[277,280]],'light gray','dark gray',0.40,49);
  poly([[270,277],[279,280],[294,276],[304,272],[299,281],[281,291],[273,288]],'black',50);
  line([[271,279],[274,289],[281,294]],'dark gray',51,2);

  // Near drop tank, pylon, and underside stores.
  poly([[347,281],[355,279],[359,295],[348,301],[342,293]],'dark gray',52);
  poly([[320,303],[339,296],[360,291],[391,284],[405,284],[410,287],[405,293],[390,300],[367,306],[338,315],[324,315],[316,311]],'dark gray',53);
  tone([[324,301],[350,295],[380,288],[401,284],[406,286],[389,293],[356,301],[334,308],[321,310]],'light gray','dark gray',0.38,54);
  poly([[366,288],[387,282],[404,284],[407,288],[399,294],[380,301],[370,299]],'black',55);
  tone([[371,287],[389,284],[402,285],[397,289],[379,296],[371,294]],'dark gray','black',0.16,56);
  missile(350,314,79,3.3,57);
  missile(332,314,65,3.2,57);
  poly([[350,309],[356,318],[363,317],[360,307]],'dark gray',62);
  poly([[387,299],[391,308],[397,306],[392,296]],'dark gray',62);

  // Upper fuselage, canopy and black radome define the recognizable profile.
  tone([[314,258],[344,245],[374,233],[402,225],[426,218],[446,217],[458,217],[454,224],[425,229],[404,236],[377,243],[347,254]],'light gray','dark gray',0.16,64);
  poly([[406,223],[425,219],[449,217],[467,217],[462,225],[450,233],[433,240],[420,240],[410,234]],'black',65);
  tone([[407,223],[426,220],[449,218],[465,218],[453,223],[433,227],[414,228]],'dark gray','black',0.18,66);
  line([[462,220],[478,213],[487,211]],'dark gray',67);
  poly([[350,232],[359,223],[375,219],[389,218],[399,221],[399,226],[380,231],[362,237]],'dark gray',68);
  tone([[355,231],[361,224],[376,219],[389,219],[396,222],[392,226],[376,228],[361,234]],'light gray','dark gray',0.42,69);
  poly([[358,230],[363,224],[373,222],[373,227],[362,231]],'dark gray',70);
  poly([[376,220],[386,219],[394,221],[390,225],[377,228]],'dark gray',70);
  line([[374,221],[374,228]],'light gray',71);
  line([[357,233],[374,228],[395,225]],'light gray',71);
  // Pilot helmet, visor and seat glimpsed beneath the curved glazing.
  oval(377,221,4,4,-20,'dark gray',72);
  oval(377,220,2.4,2.4,-20,'light gray',73);
  line([[378,220],[380,220]],'black',74);
  poly([[389,217],[394,212],[402,218],[401,222],[394,220]],'dark gray',72);
  poly([[393,214],[396,214],[399,218],[394,218]],'black',73);
  line([[342,247],[361,240],[394,231],[407,227]],'light gray',74);

  // Panel joints and modest highlights, restrained to the reference scale.
  const seams = [
    [[304,271],[319,268],[328,271]],[[333,255],[338,261]],[[348,249],[351,254]],
    [[403,225],[408,232],[415,235]],[[390,237],[394,244]],[[253,291],[261,297]],
    [[249,305],[269,301]],[[284,289],[300,283]],[[311,280],[343,267]],
    [[352,254],[379,242]],[[268,265],[274,270]],[[231,286],[242,283]],
  ];
  for(const points of seams) line(points,'dark gray',75);
  line([[300,273],[334,260],[365,249]],'light gray',76);
  oval(365,263,10,8,-25,'dark gray',76);
  tone(ovalPoints(365,262,8,6,-25),'dark gray','light gray',0.23,77);
  poly([[369,255],[377,255],[374,262],[367,268],[359,269],[359,265]],'dark gray',78);
  oval(247,269,4,2,-25,'white',76);
  line([[257,276],[261,274]],'light gray',76,2);
  poly([[261,280],[266,278],[269,283],[265,286]],'dark gray',76);

  // A reviewed revision is added only after inspecting the frozen first render.
  if (reviewed) {
    // Thin branching ridgelines break the first pass's broad geometric wedges.
    for(let i=0;i<36;i++) {
      const x=170+random()*470,y=420+random()*148;
      if(y<485-(x-150)*0.27) continue;
      const length=7+random()*17;
      twoTone([[x,y],[x+4,y-6],[x+7,y-3],[x+2,y+length],[x-4,y+length+5],[x-2,y+5]],'light gray','dark gray',0.20,9);
      line([[x+3,y-2],[x,y+5],[x-3,y+length]],'dark gray',9);
    }
    // Small upper-surface glints and panel lines soften the flat fuselage.
    for(const points of [
      [[320,262],[350,249],[368,243]],[[371,234],[398,226]],
      [[285,282],[296,278]],[[315,276],[341,266]],
      [[239,286],[251,282]],[[329,302],[352,295]],
    ]) line(points,'light gray',79);
    twoTone([[385,224],[391,222],[394,222],[390,224]],'white','light gray',0.4,79);
  }
  if(objects.length>512) throw new Error(`Composition needs ${objects.length} objects; Artboard allows 512.`);
  for(let i=0;i<objects.length;i+=128) {
    await tools.scene_apply({ scene_id, operations: objects.slice(i,i+128).map(object=>({op:'add',object})) });
  }
  const stem = reviewed ? '02-reviewed' : '01-first-shot';
  const json = await tools.scene_io({ scene_id, action:'save', filename:`${stem}.json` });
  const png = await tools.scene_io({ scene_id, action:'export', filename:`${stem}.png` });
  return { mode: reviewed?'reviewed':'first-shot', width, height, objects:objects.length, json:json.file_ref, png:png.file_ref, source_bitmap_used:false };
}

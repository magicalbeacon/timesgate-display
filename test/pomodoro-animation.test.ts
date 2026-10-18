import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {POMODORO_CAT_ANIMATION} from '../src/pomodoro-cat-animation.ts';
import {POMODORO_CAT_BACKGROUND} from '../src/pomodoro-cat-background.ts';
import {POMODORO_CAT_SLEEP_ANIMATION} from '../src/pomodoro-cat-sleep-animation.ts';

// No assets directory, Pillow, installed GIF decoder, device, or network required.
// These are conservative engineering budgets, not proof of firmware compatibility.
const DURATIONS=[780,140,160,140,120,1000];
const COLORS=['FF00FF','0C151F','182838','283D4D','F6D6A0','D8A66D','AB754F',
 'FFEAC4','E5A5A0','75BDB5','A6E0CF','456D73','BC8C78','785B59','D0D9DF'];
type Control={flags:number;duration:number;transparentIndex:number};
type Frame={left:number;top:number;width:number;height:number;flags:number;
 minimumCodeSize:number;compressed:Buffer;control:Control|undefined};

function parseGif(data:Buffer){
 let pos=0;
 const take=(length:number)=>{
  assert(pos+length<=data.length,'Truncated GIF');
  const result=data.subarray(pos,pos+length);pos+=length;return result;
 };
 const byte=()=>take(1)[0];
 const subblocks=()=>{
  const parts:Buffer[]=[];
  for(let n=byte();n;n=byte())parts.push(take(n));
  return Buffer.concat(parts);
 };
 const version=take(6).toString('ascii');assert.match(version,/^GIF8[79]a$/);
 const screen=take(7),width=screen.readUInt16LE(0),height=screen.readUInt16LE(2);
 assert(screen[4]&0x80,'Global color table required');
 const palette=take(3*(1<<((screen[4]&7)+1)));
 const frames:Frame[]=[];let control:Control|undefined,loop:number|undefined;
 while(true){
  const marker=byte();
  if(marker===0x3b){assert.equal(pos,data.length,'Bytes after GIF trailer');break;}
  if(marker===0x21){
   const label=byte(),payload=subblocks();
   if(label===0xf9){
    assert.equal(payload.length,4);
    control={flags:payload[0],duration:payload.readUInt16LE(1)*10,transparentIndex:payload[3]};
   }else if(label===0xff){
    assert.equal(payload.subarray(0,11).toString('ascii'),'NETSCAPE2.0');
    assert.equal(payload.length,14);assert.equal(payload[11],1);
    loop=payload.readUInt16LE(12);
   }else assert.fail(`Unexpected GIF extension ${label}`);
  }else if(marker===0x2c){
   const descriptor=take(9),flags=descriptor[8];
   if(flags&0x80)take(3*(1<<((flags&7)+1)));
   const minimumCodeSize=byte(),compressed=subblocks();
   frames.push({left:descriptor.readUInt16LE(0),top:descriptor.readUInt16LE(2),
    width:descriptor.readUInt16LE(4),height:descriptor.readUInt16LE(6),flags,
    minimumCodeSize,compressed,control});
   control=undefined;
  }else assert.fail(`Unexpected GIF block ${marker}`);
 }
 return {version,width,height,palette,frames,loop};
}

// Small independent LZW decoder for tests. GIF image sub-blocks are parsed first,
// so compressed bytes that happen to look like separators never count as frames.
function decodeIndices(frame:Frame){
 assert(frame.minimumCodeSize>=2&&frame.minimumCodeSize<=8);
 const clear=1<<frame.minimumCodeSize,end=clear+1;
 let dictionary:number[][]=[],codeSize=0,nextCode=0,bit=0,previous:number[]|undefined;
 const reset=()=>{
  dictionary=Array.from({length:4096},()=>[]);
  for(let i=0;i<clear;i++)dictionary[i]=[i];
  codeSize=frame.minimumCodeSize+1;nextCode=end+1;previous=undefined;
 };
 const code=()=>{
  assert(bit+codeSize<=frame.compressed.length*8,'Truncated LZW code');
  let value=0;
  for(let shift=0;shift<codeSize;shift++,bit++)
   value|=((frame.compressed[bit>>3]>>(bit&7))&1)<<shift;
  return value;
 };
 reset();
 const pixels:number[]=[];
 while(true){
  const value=code();
  if(value===clear){reset();continue;}
  if(value===end)break;
  let entry:number[];
  if(value<nextCode&&dictionary[value].length)entry=dictionary[value];
  else if(value===nextCode&&previous)entry=[...previous,previous[0]];
  else assert.fail(`Invalid LZW dictionary reference ${value}`);
  assert(pixels.length+entry.length<=frame.width*frame.height,'Excess decoded pixels');
  pixels.push(...entry);
  if(previous&&nextCode<4096){
   dictionary[nextCode++]=[...previous,entry[0]];
   if(nextCode===(1<<codeSize)&&codeSize<12)codeSize++;
  }
  previous=entry;
 }
 assert.equal(pixels.length,frame.width*frame.height);
 const decoded=Buffer.from(pixels);
 if(!(frame.flags&0x40))return decoded;
 // The unchanged static source uses GIF interlacing; restore its row order.
 const raster=Buffer.alloc(decoded.length);let row=0;
 for(const [start,step] of [[0,8],[4,8],[2,4],[1,2]])
  for(let y=start;y<frame.height;y+=step){
   decoded.copy(raster,y*frame.width,row*frame.width,(row+1)*frame.width);row++;
  }
 assert.equal(row,frame.height);return raster;
}

test('embedded animated cat has a bounded infinite loop with six opaque full frames and one palette',()=>{
 const gif=parseGif(POMODORO_CAT_ANIMATION);
 assert.equal(gif.version,'GIF89a');assert.equal(gif.width,128);assert.equal(gif.height,128);
 assert(POMODORO_CAT_ANIMATION.length<=32*1024,'Engineering asset budget');
 assert(gif.frames.length>=4&&gif.frames.length<=8,'Engineering frame budget');
 assert.equal(gif.frames.length,6);assert.equal(gif.loop,0);
 const expectedPalette=Buffer.alloc(768);Buffer.from(COLORS.join(''),'hex').copy(expectedPalette);
 assert.deepEqual(gif.palette,expectedPalette);
 const durations=gif.frames.map(frame=>{
  assert.deepEqual([frame.left,frame.top,frame.width,frame.height],[0,0,128,128]);
  assert.equal(frame.flags,0,'No local palette, interlacing, or reserved flags');
  assert(frame.control,'Each frame must have an explicit graphic control');
  assert.equal(frame.control.flags,4,'Disposal 1, no transparency, no user input');
  assert.equal(frame.control.transparentIndex,0);
  assert(frame.control.duration>=100&&frame.control.duration<=2000);
  return frame.control.duration;
 });
 assert.deepEqual(durations,DURATIONS);
 assert.equal(durations.reduce((a,b)=>a+b,0),2340);
 assert(durations.reduce((a,b)=>a+b,0)<=5000,'Engineering loop-duration budget');
});

test('independently decoded frames never use palette zero and preserve the clear footer and original background',()=>{
 const gif=parseGif(POMODORO_CAT_ANIMATION),original=parseGif(POMODORO_CAT_BACKGROUND);
 assert.equal(original.frames.length,1);assert.deepEqual(gif.palette,original.palette);
 const reference=decodeIndices(original.frames[0]);
 const frames=gif.frames.map(decodeIndices);
 assert.equal(new Set(frames.map(frame=>frame.toString('base64'))).size,4,'Rest, lift, tap, blink');
 assert.deepEqual(frames[0],reference);assert.deepEqual(frames.at(-1),reference);
 for(const [i,frame] of frames.entries()){
  assert(!frame.includes(0),`Reserved palette index 0 used in frame ${i}`);
  assert.deepEqual(frame.subarray(108*128,124*128),Buffer.alloc(16*128,1),`Footer frame ${i}`);
  for(let y=0;y<128;y++)for(let x=0;x<128;x++){
   const allowedMotion=(x>=48&&x<68&&y>=72&&y<82)||
    (y>=50&&y<58&&((x>=42&&x<48)||(x>=70&&x<76)));
   if(!allowedMotion)assert.equal(frame[y*128+x],reference[y*128+x],`Background ${i}:${x},${y}`);
  }
 }
});

test('GIF structural reader rejects truncated or trailing data rather than guessing a frame count',()=>{
 assert.throws(()=>parseGif(POMODORO_CAT_ANIMATION.subarray(0,-1)),/Truncated GIF/);
 assert.throws(()=>parseGif(Buffer.concat([POMODORO_CAT_ANIMATION,Buffer.from([0])])),/Bytes after GIF trailer/);
});


test('sleeping cat has a bounded 3.6-second infinite loop with six opaque full frames and the same global palette',()=>{
 const gif=parseGif(POMODORO_CAT_SLEEP_ANIMATION),typing=parseGif(POMODORO_CAT_ANIMATION);
 assert.equal(gif.version,'GIF89a');assert.equal(gif.width,128);assert.equal(gif.height,128);
 assert(POMODORO_CAT_SLEEP_ANIMATION.length<=32*1024,'Engineering asset budget');
 assert(gif.frames.length>=4&&gif.frames.length<=8,'Engineering frame budget');
 assert.equal(gif.frames.length,6);assert.equal(gif.loop,0);
 assert.deepEqual(gif.palette,typing.palette);
 const durations=gif.frames.map(frame=>{
  assert.deepEqual([frame.left,frame.top,frame.width,frame.height],[0,0,128,128]);
  assert.equal(frame.flags,0,'No local palette, interlacing, or reserved flags');
  assert(frame.control,'Every sleep frame needs an explicit graphic control');
  assert.equal(frame.control.flags,4,'Disposal 1; no transparency or user input');
  assert.equal(frame.control.transparentIndex,0);
  assert(frame.control.duration>=100&&frame.control.duration<=2000);
  return frame.control.duration;
 });
 assert.deepEqual(durations,[900,600,120,480,500,1000]);
 assert.equal(durations.reduce((a,b)=>a+b,0),3600);
 assert(durations.reduce((a,b)=>a+b,0)<=5000,'Engineering loop-duration budget');
 assert.throws(()=>parseGif(POMODORO_CAT_SLEEP_ANIMATION.subarray(0,-1)),/Truncated GIF/);
 assert.throws(()=>parseGif(Buffer.concat([POMODORO_CAT_SLEEP_ANIMATION,Buffer.from([0])])),/Bytes after GIF trailer/);
});

test('independently decoded sleep frames preserve original art, closed eyes, clear footer, and unused palette zero',()=>{
 const frames=parseGif(POMODORO_CAT_SLEEP_ANIMATION).frames.map(decodeIndices),reference=frames[0];
 // SHA-256 of the decoded original break-concept image, so Docker needs no asset file.
 assert.equal(createHash('sha256').update(reference).digest('hex'),
  'bf156972c11c6524fdf02676e64531b4e4ac566e5e7a0074779200f990e38665');
 assert.equal(new Set(frames.map(frame=>frame.toString('base64'))).size,3,'Rest, breath, ear twitch');
 assert.deepEqual(frames.at(-1),reference);
 for(const [i,frame] of frames.entries()){
  assert(!frame.includes(0),`Reserved palette index 0 used in sleep frame ${i}`);
  assert.deepEqual(frame.subarray(108*128,124*128),Buffer.alloc(16*128,1),`Sleep footer ${i}`);
  for(let y=0;y<128;y++)for(let x=0;x<128;x++){
   const allowedMotion=x>=48&&x<98&&y>=44&&y<82;
   const sleepingFace=x>=38&&x<68&&y>=62&&y<72;
   if(!allowedMotion||sleepingFace)
    assert.equal(frame[y*128+x],reference[y*128+x],`Sleep background/face ${i}:${x},${y}`);
  }
 }
});

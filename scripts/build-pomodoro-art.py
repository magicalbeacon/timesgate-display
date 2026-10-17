from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import base64
root=Path(__file__).resolve().parents[1]
colors=['#FF00FF','#000000','#0A202B','#64DFFF','#FFCB70','#FF9A94','#D5ADFF','#8DABBF','#89E0A9']
im=Image.new('P',(128,128),1);palette=[]
for color in colors:palette.extend(bytes.fromhex(color[1:]))
im.putpalette(palette+[0]*(768-len(palette)));d=ImageDraw.Draw(im)
# Static tomato/timer illustration. It does not pretend to be a live progress ring.
d.ellipse((3,2,17,13),fill=5);d.polygon([(8,3),(7,0),(11,2),(14,0),(13,4)],fill=8)
d.line((8,6,8,10),fill=4,width=1)
f='/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
d.text((24,-1),'POMODORO',font=ImageFont.truetype(f,11),fill=3)
d.text((107,2),'10s',font=ImageFont.truetype(f,7),fill=7)
d.line((3,15,124,15),fill=2)
d.line((3,74,124,74),fill=3);d.line((3,75,124,75),fill=2)
assert 0 not in im.getdata()
p=root/'assets/pomodoro-v1.gif';im.save(p,optimize=False)
(root/'src/pomodoro-background.ts').write_text("// Original static artwork; palette index0 is unused. No animated/progress claims.\nexport const POMODORO_BACKGROUND=Buffer.from('"+base64.b64encode(p.read_bytes()).decode()+"','base64');\n")

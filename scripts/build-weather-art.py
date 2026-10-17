from pathlib import Path
from PIL import Image, ImageDraw
import base64
root=Path(__file__).resolve().parents[1]
# Original code-native pixel artwork; index zero is reserved and never drawn.
colors=['#FF00FF','#000000','#07151D','#132C3C','#FFCB70','#FFE2A8','#F48F9D','#AFC5D4','#62CCFF','#FF9A94','#D5ADFF']
im=Image.new('P',(128,128),1)
palette=[]
for c in colors: palette.extend(bytes.fromhex(c[1:]))
im.putpalette(palette+[0]*(768-len(palette)))
d=ImageDraw.Draw(im)
# A neutral umbrella motif represents the weather panel, not current conditions.
d.rectangle((0,0,31,31),fill=2)
d.arc((4,4,27,26),180,360,fill=4,width=2)
d.line((4,15,27,15),fill=4,width=2)
d.arc((4,12,12,18),180,360,fill=4,width=1)
d.arc((12,12,20,18),180,360,fill=4,width=1)
d.arc((20,12,28,18),180,360,fill=4,width=1)
d.line((16,5,16,24),fill=5,width=2)
d.arc((10,20,17,28),0,180,fill=5,width=2)
d.point((16,3),fill=5)
# Three distinct blocks, with real full-width divider lines and breathing room.
d.line((3,35,124,35),fill=4,width=1)
d.line((3,36,124,36),fill=3,width=1)
d.line((3,84,124,84),fill=8,width=1)
d.line((3,85,124,85),fill=3,width=1)
d.line((84,42,84,63),fill=3,width=1)
# Fixed headings/units; all current values remain native polled text.
from PIL import ImageFont
fontbase='/usr/share/fonts/truetype/dejavu/'
heading=ImageFont.truetype(fontbase+'DejaVuSansMono-Bold.ttf',12)
tiny=ImageFont.truetype(fontbase+'DejaVuSansMono.ttf',8)
unit=ImageFont.truetype(fontbase+'DejaVuSansMono.ttf',12)
d.text((36,0),'YISHUN',font=heading,fill=4)
glyphs={
 'N':'10001/11001/10101/10011/10001/10001/10001',
 'E':'11111/10000/10000/11110/10000/10000/11111',
 'A':'01110/10001/10001/11111/10001/10001/10001',
 'S':'01111/10000/10000/01110/00001/00001/11110',
 'G':'01110/10001/10000/10111/10001/10001/01110',
 'T':'11111/00100/00100/00100/00100/00100/00100',
 'C':'01111/10000/10000/10000/10000/10000/01111',
 '%':'11001/11010/00100/01000/10110/00110/00000',
}
def pixel_text(text,x,y,color):
 for i,c in enumerate(text):
  for dy,row in enumerate(glyphs[c].split('/')):
   for dx,b in enumerate(row):
    if b=='1': d.point((x+6*i+dx,y+dy),fill=color)
pixel_text('NEA',106,1,7)
pixel_text('SGT',106,10,7)
# Coral thermometer beside the existing 74px temperature cell.
# Keep all artwork at x>=74 so even 99.9 (four 18px cells) stays unobscured.
d.rounded_rectangle((76,39,80,51),radius=2,outline=9,width=1)
d.ellipse((74,49,82,57),fill=9)
d.line((78,43,78,53),fill=9,width=1)
d.point((77,53),fill=5)
# Compact degree-C unit below the thermometer, above the observation caption.
d.ellipse((74,59,76,61),outline=9,width=1)
pixel_text('C',79,59,9)
# Tiny humidity drop above the right-hand value.
d.polygon([(108,40),(104,45),(105,47),(111,47),(112,45)],fill=10)
# Larger drop and percent label identify the rain-probability block.
d.polygon([(7,92),(2,100),(2,103),(5,106),(9,106),(12,103),(11,98)],fill=8)
d.line((4,100,4,103,6,104),fill=7,width=1)
# Percent is part of the centred native font492 string, never a fixed background unit.
assert 0 not in im.getdata()
assets=root/'assets';assets.mkdir(exist_ok=True)
im.save(assets/'weather-thermometer.gif',optimize=False)
# Runtime embeds the exact original GIF, so no extra Docker asset-copy dependency.
path=root/'src/weather-background.ts'
old=path.read_text().split('\nexport const WEATHER_THERMOMETER_BACKGROUND')[0].rstrip()
new="\n// Original neutral illustrations. GIF palette index0 is reserved/unused for TimesGate firmware.\nexport const WEATHER_THERMOMETER_BACKGROUND=Buffer.from('"+base64.b64encode((assets/'weather-thermometer.gif').read_bytes()).decode()+"','base64');\n"
path.write_text(old+new)
# Authoring-only helper: Pillow is not a runtime/container dependency.

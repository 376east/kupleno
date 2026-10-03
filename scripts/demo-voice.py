from pathlib import Path
import asyncio,json,subprocess,math,argparse,hashlib
root=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description='Narrate the synthetic Kupleno recording; network TTS unless cached.')
parser.add_argument('--source',type=Path,default=root/'assets/demo/kupleno-0.21-silent.mp4')
parser.add_argument('--output',type=Path,default=root/'work/demo-voice/kupleno-voice.mp4')
parser.add_argument('--work',type=Path,default=root/'work/demo-voice')
parser.add_argument('--scenes',type=Path,default=root/'scripts/demo-scenes.json')
parser.add_argument('--offline',action='store_true',help='Fail if narration audio is not cached')
args=parser.parse_args()
w=args.work.resolve();w.mkdir(parents=True,exist_ok=True)
source=args.source.resolve();scenes=json.loads(args.scenes.read_text(encoding='utf-8'))
assert source.is_file(),source
for key,start,end,text in scenes:
 assert key.replace('-','').isalnum() and 0 <= start < end and isinstance(text,str)
def run(args): subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y',*args],check=True)
def duration(p):return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(p)]))
async def main():
 timeline=[];offset=0
 for key,start,end,text in scenes:
  digest=hashlib.sha256(('ru-RU-SvetlanaNeural|+5%|'+text).encode()).hexdigest()[:12]
  voice=w/(key+'-'+digest+'.mp3')
  if not voice.exists():
   if args.offline: raise RuntimeError('Missing cached voice: '+voice.name)
   import edge_tts
   partial=voice.with_suffix('.partial.mp3')
   await edge_tts.Communicate(text,'ru-RU-SvetlanaNeural',rate='+5%').save(str(partial))
   partial.replace(voice)
  vd=duration(voice);length=math.ceil(max(end-start,vd+.85)*30)/30
  target=w/(key+'.mp4')
  run(['-ss',str(start),'-t',str(end-start),'-i',str(source),'-i',str(voice),'-map','0:v:0','-map','1:a:0','-vf',f'tpad=stop_mode=clone:stop_duration={length},fps=30','-af','adelay=300:all=1,apad,loudnorm=I=-16:TP=-2:LRA=8,aresample=48000','-t',str(length),'-c:v','libx264','-crf','19','-preset','fast','-pix_fmt','yuv420p','-c:a','aac','-b:a','192k','-ar','48000',str(target)])
  timeline.append(dict(scene=key,start=offset,end=offset+length,voice_start=offset+.3,voice_end=offset+.3+vd,text=text));offset+=length
  print(key,round(length,2),flush=True)
 (w/'concat.txt').write_text('\n'.join("file '"+key+".mp4'" for key,*_ in scenes),encoding='utf8')
 output=args.output.resolve();output.parent.mkdir(parents=True,exist_ok=True)
 run(['-f','concat','-safe','0','-i',str(w/'concat.txt'),'-c','copy','-movflags','+faststart',str(output)])
 assert all(s['start']<s['voice_start']<s['voice_end']<s['end'] for s in timeline)
 assert abs(duration(output)-offset)<.2
 run(['-i',str(output),'-f','null','-'])
 (w/'timeline.json').write_text(json.dumps(timeline,ensure_ascii=False,indent=2),encoding='utf8')
 print('PASS: full decode, voice inside each scene; seconds',duration(output),flush=True)
asyncio.run(main())

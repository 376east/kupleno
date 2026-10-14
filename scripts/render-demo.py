"""Encode the eight validated static HyperFrames scenes with their 0.25s fades."""
import argparse
import json
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--frames', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
frames = sorted(args.frames.glob('frame-*-at-*s.png'))
durations = [4, 9, 4, 5, 8, 4, 4, 5]
assert len(frames) == len(durations) == 8, 'Snapshot every scene before encoding'
assert sum(durations) == 43
args.output.parent.mkdir(parents=True, exist_ok=True)
command = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
for frame, duration in zip(frames, durations):
    command += ['-loop', '1', '-framerate', '30', '-t', str(duration), '-i', str(frame)]
filters = [f'[{i}:v]fade=t=in:st=0:d=0.25:color=0xfaf9f6,setsar=1[v{i}]' for i in range(8)]
filters.append(''.join(f'[v{i}]' for i in range(8)) + 'concat=n=8:v=1:a=0,format=yuv420p[out]')
command += ['-filter_complex', ';'.join(filters), '-map', '[out]', '-c:v', 'libx264', '-crf', '18', '-movflags', '+faststart', str(args.output)]
options = {'check': True, 'creationflags': subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0}
subprocess.run(command, **options)
probe = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(args.output)], creationflags=options['creationflags']))
stream = next(s for s in probe['streams'] if s['codec_type'] == 'video')
assert (stream['width'], stream['height'], stream['r_frame_rate']) == (1920, 1080, '30/1')
assert abs(float(probe['format']['duration']) - 43) < 0.05
subprocess.run(['ffmpeg', '-v', 'error', '-i', str(args.output), '-f', 'null', '-'], **options)
print(json.dumps({'file': str(args.output), 'duration': probe['format']['duration'], 'frames': stream.get('nb_frames'), 'provider': 'HyperFrames snapshots + ffmpeg'}, ensure_ascii=False))

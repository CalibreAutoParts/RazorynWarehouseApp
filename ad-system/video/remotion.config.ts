import {Config} from '@remotion/cli/config';
Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(100);   // crisp frames (clean imaging)
Config.setCrf(18);            // high-quality H.264 (lower crf = higher quality)
Config.setOverwriteOutput(true);
Config.setConcurrency(2);

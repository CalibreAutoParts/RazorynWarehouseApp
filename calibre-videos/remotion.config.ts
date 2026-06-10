import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// High quality H.264 for social platforms (TikTok / Instagram Reels)
Config.setCodec('h264');
Config.setCrf(18);
Config.setConcurrency(null); // auto based on cores
Config.setChromiumOpenGlRenderer('angle');
Config.setDelayRenderTimeoutInMilliseconds(90000);

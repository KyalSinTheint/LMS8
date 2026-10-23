import React, { useState, useEffect, useRef, useCallback } from 'react';
import { SkillDevelopmentResource, LessonProgressInfo } from '../../types/lms';
import { useLms } from '../../context/LmsContext';
import { ViewerWatermark } from '../common/ViewerWatermark';
import { extractYouTubeId } from '../../lib/videoUtils';
import {
  X,
  Play,
  Pause,
  Clock,
  HardDrive,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  ShieldAlert,
  RotateCcw,
  RefreshCw,
  Loader2,
  ExternalLink,
} from 'lucide-react';

interface SkillVideoPlayerModalProps {
  resource: SkillDevelopmentResource;
  onClose: () => void;
}

function formatPlaybackTime(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export const SkillVideoPlayerModal: React.FC<SkillVideoPlayerModalProps> = ({
  resource,
  onClose,
}) => {
  const { currentUser, getLessonProgress, recordVideoHeartbeat, showToast } = useLms();
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Load user progress for this specific video resource
  const initialProgress = getLessonProgress(resource.id);
  const [progressInfo, setProgressInfo] = useState<LessonProgressInfo>(initialProgress);

  // Playback & anti-scrubbing references
  const isPlayingRef = useRef<boolean>(false);
  const lastTimeRef = useRef<number>(initialProgress.last_position || 0);
  const segmentStartRef = useRef<number>(initialProgress.last_position || 0);
  const lastSendTimeRef = useRef<number>(Date.now());
  const [hasRestoredPosition, setHasRestoredPosition] = useState<boolean>(false);
  const [seekWarning, setSeekWarning] = useState<string | null>(null);

  // Player state: loading, error, direct fallback, timestamps
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [hasPlaybackError, setHasPlaybackError] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [useDirectFallback, setUseDirectFallback] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(initialProgress.last_position || 0);
  const [duration, setDuration] = useState<number>(0);

  const rawVideoUrl = (resource.file_url || resource.content_url || '').trim();
  const ytId = extractYouTubeId(rawVideoUrl);

  // In-app stream URL with Range support & anti-download headers
  const streamUrl = useDirectFallback
    ? rawVideoUrl
    : `/api/license/stream-video?url=${encodeURIComponent(rawVideoUrl)}&lessonId=${encodeURIComponent(resource.id)}`;

  const displayCategory = resource.category || resource.topic || 'Skill Development';

  // Flush genuine watched interval to server & Supabase
  const sendSegmentProgress = useCallback(
    async (start: number, end: number, currentPos: number) => {
      const video = videoRef.current;
      const totalDur = duration || (video?.duration) || 1;
      const playbackRate = video?.playbackRate || 1.0;

      if (end > start && end - start > 0.4) {
        try {
          const updated = await recordVideoHeartbeat(
            resource.id,
            { start, end },
            totalDur,
            playbackRate,
            currentPos
          );
          if (updated) {
            setProgressInfo(updated);
          }
        } catch (err) {
          console.warn('[KBZLife LMS] Video heartbeat update notice:', err);
        }
      }
    },
    [duration, recordVideoHeartbeat, resource.id]
  );

  // When video metadata is loaded, restore last position if available
  const handleLoadedMetadata = () => {
    const video = videoRef.current;
    if (!video) return;

    setIsLoading(false);
    setHasPlaybackError(false);
    setDuration(video.duration || 0);

    // Restore user's previous position if they haven't completed the video
    if (!hasRestoredPosition && progressInfo.last_position && progressInfo.last_position > 3) {
      if (progressInfo.progress_percentage < 95 && progressInfo.last_position < video.duration - 5) {
        video.currentTime = progressInfo.last_position;
        setCurrentTime(progressInfo.last_position);
        showToast('info', 'Playback Resumed', `Resumed from ${formatPlaybackTime(progressInfo.last_position)}`);
      }
      setHasRestoredPosition(true);
    }

    lastTimeRef.current = video.currentTime;
    segmentStartRef.current = video.currentTime;
  };

  const handlePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    isPlayingRef.current = true;
    setIsLoading(false);
    lastTimeRef.current = video.currentTime;
    segmentStartRef.current = video.currentTime;
    lastSendTimeRef.current = Date.now();
    setSeekWarning(null);
  };

  const handlePause = () => {
    const video = videoRef.current;
    if (!video) return;
    isPlayingRef.current = false;
    const curr = video.currentTime;
    const start = segmentStartRef.current;
    sendSegmentProgress(start, curr, curr);
    lastTimeRef.current = curr;
    segmentStartRef.current = curr;
  };

  // Anti-scrubbing: flush before jump, detect forward skips
  const handleSeeking = () => {
    const video = videoRef.current;
    if (!video) return;

    const prev = lastTimeRef.current;
    const start = segmentStartRef.current;
    if (prev > start && prev - start > 0.5) {
      sendSegmentProgress(start, prev, prev);
    }

    const curr = video.currentTime;
    if (curr > prev + 5) {
      setSeekWarning('Seeking ahead detected. Full playback is required for module completion.');
      setTimeout(() => setSeekWarning(null), 4000);
    }
  };

  const handleSeeked = () => {
    const video = videoRef.current;
    if (!video) return;
    lastTimeRef.current = video.currentTime;
    segmentStartRef.current = video.currentTime;
    lastSendTimeRef.current = Date.now();
    setCurrentTime(video.currentTime);
  };

  // Real-time timeupdate: heartbeat every ~3 seconds
  const handleTimeUpdate = () => {
    const video = videoRef.current;
    if (!video) return;

    setCurrentTime(video.currentTime);

    if (!isPlayingRef.current) return;

    const curr = video.currentTime;
    const prev = lastTimeRef.current;
    const delta = curr - prev;

    // Normal forward playback
    if (delta > 0 && delta <= 3.5) {
      lastTimeRef.current = curr;

      const now = Date.now();
      if (now - lastSendTimeRef.current >= 3000) {
        const start = segmentStartRef.current;
        sendSegmentProgress(start, curr, curr);
        segmentStartRef.current = curr;
        lastSendTimeRef.current = now;
      }
    } else if (delta > 3.5 || delta < 0) {
      // Seek detected without seeking event trigger
      segmentStartRef.current = curr;
      lastTimeRef.current = curr;
    }
  };

  // Video playback completion check
  const handleEnded = () => {
    const video = videoRef.current;
    if (!video) return;
    isPlayingRef.current = false;
    const curr = video.currentTime;
    const start = segmentStartRef.current;
    sendSegmentProgress(start, curr, curr);

    if (progressInfo.progress_percentage >= 95 || progressInfo.completion_status === 'completed') {
      showToast('success', 'Class Completed!', `Congratulations! You have successfully completed "${resource.title}".`);
    } else {
      showToast(
        'info',
        'Progress Saved',
        `You have watched ${progressInfo.progress_percentage}% of this class. Complete the full lesson to earn class credit.`
      );
    }
  };

  // Handle playback error (e.g., proxy issue -> switch to direct stream)
  const handleVideoError = () => {
    setIsLoading(false);
    if (!useDirectFallback && rawVideoUrl.startsWith('http')) {
      // Automatically attempt fallback directly to the raw URL
      console.warn('[KBZLife LMS] Proxy stream error, attempting direct stream fallback...');
      setUseDirectFallback(true);
      setHasPlaybackError(false);
    } else {
      setHasPlaybackError(true);
      setErrorMessage(
        'The video stream could not be loaded. Please verify your connection or try direct playback.'
      );
    }
  };

  // Safely close modal after saving last watched segment
  const handleClose = () => {
    const video = videoRef.current;
    if (video && isPlayingRef.current) {
      const curr = video.currentTime;
      const start = segmentStartRef.current;
      sendSegmentProgress(start, curr, curr);
    }
    onClose();
  };

  const isCompleted =
    progressInfo.completion_status === 'completed' || progressInfo.progress_percentage >= 95;
  const percentage = Math.min(100, Math.max(0, progressInfo.progress_percentage || 0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6 bg-slate-950/85 backdrop-blur-sm overflow-y-auto select-none"
      onClick={handleClose}
      onContextMenu={(e) => e.preventDefault()}
      style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
    >
      <div
        className="bg-white rounded-3xl max-w-4xl w-full overflow-hidden shadow-2xl border border-slate-200 my-auto animate-in fade-in zoom-in-95 duration-200 text-left relative"
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {/* Header Bar */}
        <div className="p-4 sm:p-5 border-b border-slate-200 flex items-center justify-between bg-[#F3F8FB]">
          <div className="flex items-center gap-3 min-w-0 pr-4">
            <div className="w-10 h-10 rounded-2xl bg-[#176B98] text-white flex items-center justify-center shrink-0 shadow-xs">
              <Play className="w-4 h-4 fill-white ml-0.5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-xs text-slate-500 mb-0.5 flex-wrap">
                <span className="font-bold text-[#176B98]">Skill Development Video</span>
                <span aria-hidden="true" className="text-slate-300">·</span>
                <span className="font-medium text-slate-700 bg-white px-2 py-0.5 rounded-md border border-slate-200">
                  {displayCategory}
                </span>
                {resource.display_order && (
                  <>
                    <span aria-hidden="true" className="text-slate-300">·</span>
                    <span>Class #{resource.display_order}</span>
                  </>
                )}
              </div>
              <h3 className="text-sm sm:text-base font-extrabold text-slate-900 truncate">
                {resource.title}
              </h3>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Status indicator badge */}
            <div
              className={`px-3 py-1 rounded-xl text-xs font-bold flex items-center gap-1.5 shadow-2xs ${
                isCompleted
                  ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                  : percentage > 0
                  ? 'bg-sky-50 text-[#176B98] border border-sky-200'
                  : 'bg-slate-100 text-slate-600 border border-slate-200'
              }`}
            >
              {isCompleted ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Completed (100%)</span>
                </>
              ) : (
                <>
                  <Clock className="w-3.5 h-3.5 text-[#176B98]" />
                  <span>{percentage}% Watched</span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={handleClose}
              className="w-8 h-8 rounded-full bg-white hover:bg-slate-200 text-slate-600 flex items-center justify-center transition-colors cursor-pointer shrink-0 shadow-2xs"
              aria-label="Close video player"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Real-time Progress Bar Strip */}
        <div className="bg-slate-100 border-b border-slate-200/80 px-4 sm:px-6 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-3">
            <span className="font-bold text-slate-700">Completion Status:</span>
            <div className="w-40 sm:w-56 h-2.5 bg-slate-200 rounded-full overflow-hidden p-0.5 shadow-inner">
              <div
                className={`h-full rounded-full transition-all duration-300 ${
                  isCompleted
                    ? 'bg-gradient-to-r from-emerald-500 to-emerald-600'
                    : 'bg-gradient-to-r from-[#176B98] to-[#25A9D2]'
                }`}
                style={{ width: `${percentage}%` }}
              />
            </div>
            <span className="font-extrabold text-slate-800 tabular-nums font-mono">
              {percentage}%
            </span>
          </div>

          <div className="text-[11px] text-slate-600 flex items-center gap-2">
            <span className="font-mono bg-white px-2 py-0.5 rounded border border-slate-200 font-semibold">
              {formatPlaybackTime(currentTime)} / {formatPlaybackTime(duration || 0)}
            </span>
            <span className="text-slate-400">·</span>
            <span className="flex items-center gap-1 text-slate-500">
              <ShieldCheck className="w-3.5 h-3.5 text-[#176B98]" />
              <span>Full playback required for module completion</span>
            </span>
          </div>
        </div>

        {/* Seek Warning Banner (Anti-Cheat Notification) */}
        {seekWarning && (
          <div className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-xs text-amber-900 flex items-center gap-2 animate-in fade-in duration-150">
            <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
            <span>{seekWarning}</span>
          </div>
        )}

        {/* Video Player Area with Watermark & Security Shield */}
        <div
          className="relative bg-black aspect-16/9 flex items-center justify-center overflow-hidden"
          onContextMenu={(e) => e.preventDefault()}
        >
          {/* Watermark stamped with logged-in user identity */}
          <ViewerWatermark user={currentUser} contextLabel="KBZLIFE SKILL DEVELOPMENT" variant="video" />

          {/* Buffering / Loading Spinner */}
          {isLoading && !hasPlaybackError && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-black/70 backdrop-blur-xs text-white space-y-2 pointer-events-none">
              <Loader2 className="w-8 h-8 text-[#25A9D2] animate-spin" />
              <p className="text-xs font-semibold text-white/90">Buffering secure video stream...</p>
            </div>
          )}

          {/* Error State Card */}
          {hasPlaybackError ? (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center bg-slate-900/90 text-white p-6 text-center space-y-3">
              <div className="w-12 h-12 rounded-2xl bg-red-950/80 text-red-400 flex items-center justify-center border border-red-500/30">
                <AlertCircle className="w-6 h-6" />
              </div>
              <div className="max-w-md space-y-1">
                <h4 className="text-sm font-bold text-white">Video Playback Notice</h4>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {errorMessage || 'Unable to load video stream from the media server.'}
                </p>
              </div>
              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setHasPlaybackError(false);
                    setIsLoading(true);
                    setUseDirectFallback(true);
                    if (videoRef.current) {
                      videoRef.current.load();
                    }
                  }}
                  className="px-4 py-2 rounded-xl bg-[#176B98] hover:bg-[#12567a] text-white text-xs font-bold transition-colors cursor-pointer flex items-center gap-1.5 shadow-xs"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Try Direct Stream</span>
                </button>
                <button
                  type="button"
                  onClick={handleClose}
                  className="px-4 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-bold transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          ) : ytId ? (
            /* YouTube Embed with Custom Protected Wrapper */
            <div className="w-full h-full relative z-10">
              <iframe
                src={`https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0&modestbranding=1`}
                title={resource.title}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="w-full h-full border-0"
                onLoad={() => setIsLoading(false)}
              />
            </div>
          ) : (
            /* HTML5 Video Player with Protected Range Streaming */
            <video
              ref={videoRef}
              src={streamUrl}
              controls
              autoPlay
              controlsList="nodownload"
              disablePictureInPicture
              onContextMenu={(e) => e.preventDefault()}
              onLoadedMetadata={handleLoadedMetadata}
              onPlay={handlePlay}
              onPause={handlePause}
              onSeeking={handleSeeking}
              onSeeked={handleSeeked}
              onTimeUpdate={handleTimeUpdate}
              onEnded={handleEnded}
              onWaiting={() => setIsLoading(true)}
              onPlaying={() => setIsLoading(false)}
              onCanPlay={() => setIsLoading(false)}
              onError={handleVideoError}
              className="w-full h-full object-contain relative z-10"
              poster={resource.thumbnail_url}
            >
              Your browser does not support HTML5 video playback.
            </video>
          )}
        </div>

        {/* Footer Meta & Policy Information (Strictly View-Only: NO DOWNLOAD BUTTONS) */}
        <div className="p-5 sm:p-6 space-y-4 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
            <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
              {(resource.video_duration || resource.duration) && (
                <span className="flex items-center gap-1.5 font-semibold text-slate-800 font-mono">
                  <Clock className="w-3.5 h-3.5 text-[#176B98]" />
                  <span>Duration: {resource.video_duration || resource.duration}</span>
                </span>
              )}
              {resource.file_size_formatted && (
                <span className="flex items-center gap-1.5 font-mono text-slate-600">
                  <HardDrive className="w-3.5 h-3.5" />
                  <span>{resource.file_size_formatted}</span>
                </span>
              )}
              <span className="flex items-center gap-1.5 text-emerald-700 font-semibold">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Internal Learning Material · Watermark Protected</span>
              </span>
            </div>

            {/* Instructor / Curator Attribution */}
            <div className="flex items-center gap-2">
              {resource.instructor_avatar ? (
                <img
                  src={resource.instructor_avatar}
                  alt={resource.instructor_name || 'KBZ Life Insurance'}
                  className="w-7 h-7 rounded-full object-cover border border-slate-200"
                />
              ) : (
                <div className="w-7 h-7 rounded-full bg-[#176B98]/10 text-[#176B98] flex items-center justify-center font-bold text-[11px] p-0.5">
                  <img
                    src="/assets/aistudio/KBZ_Logo_28e9d8fb.png"
                    alt="KBZ Life Insurance"
                    className="w-full h-full object-contain"
                  />
                </div>
              )}
              <div className="text-left">
                <span className="block text-xs font-bold text-slate-800">
                  {resource.instructor_name && !/KBZ\s*Life\s*Academy/i.test(resource.instructor_name)
                    ? resource.instructor_name
                    : 'KBZ Life Insurance'}
                </span>
                <span className="block text-[10px] text-slate-500">
                  {resource.instructor_title && !/KBZ\s*Life\s*Academy/i.test(resource.instructor_title)
                    ? resource.instructor_title
                    : 'Lead Specialist'}
                </span>
              </div>
            </div>
          </div>

          {resource.description && (
            <div>
              <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-1">
                Overview & Learning Objectives
              </h4>
              <p className="text-xs text-slate-600 leading-relaxed">
                {resource.description}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

import type {
  AIPlatform,
  DebateSession,
  DebateStage,
  DebateStatus
} from "../shared/debate-types.js";

export interface ActiveStreamState {
  debateId: string;
  taskId: string;
  turnId?: string;
  round: number;
  stage: Exclude<DebateStage, "completed">;
  platform: AIPlatform;
  content: string;
  startedAt: string;
}

export type StreamHubEvent =
  | {
      type: "stream_start";
      data: Omit<ActiveStreamState, "content">;
    }
  | {
      type: "stream_delta";
      data: {
        debateId: string;
        taskId: string;
        delta: string;
      };
    }
  | {
      type: "stream_reset";
      data: {
        debateId: string;
        taskId: string;
      };
    }
  | {
      type: "stream_end";
      data: {
        debateId: string;
        taskId: string;
      };
    }
  | {
      type: "debate_updated";
      data: {
        debateId: string;
        status: DebateStatus;
        currentRound: number;
        currentStage: DebateStage;
        updatedAt: string;
      };
    }
  | {
      type: "providers_updated";
      data: {
        at: string;
      };
    };

type Listener = (event: StreamHubEvent) => void;

const listeners = new Set<Listener>();
const activeStreams = new Map<string, ActiveStreamState>();

function broadcast(event: StreamHubEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // Ignora erro de cliente desconectado.
    }
  }
}

export function subscribeStreamHub(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getActiveStreams(debateId?: string): ActiveStreamState[] {
  const list = Array.from(activeStreams.values());
  if (!debateId) return list;
  return list.filter((s) => s.debateId === debateId);
}

export function startTaskStream(info: Omit<ActiveStreamState, "content">): void {
  activeStreams.set(info.taskId, {
    ...info,
    content: ""
  });

  broadcast({
    type: "stream_start",
    data: info
  });
}

export function pushTaskStreamDelta(
  debateId: string,
  taskId: string,
  delta: string
): void {
  if (!delta) return;

  const entry = activeStreams.get(taskId);
  if (entry) {
    entry.content += delta;
  }

  broadcast({
    type: "stream_delta",
    data: {
      debateId,
      taskId,
      delta
    }
  });
}

export function resetTaskStream(debateId: string, taskId: string): void {
  const entry = activeStreams.get(taskId);
  if (entry) {
    entry.content = "";
  }

  broadcast({
    type: "stream_reset",
    data: {
      debateId,
      taskId
    }
  });
}

export function endTaskStream(debateId: string, taskId: string): void {
  activeStreams.delete(taskId);

  broadcast({
    type: "stream_end",
    data: {
      debateId,
      taskId
    }
  });
}

export function emitDebateUpdated(session: DebateSession): void {
  broadcast({
    type: "debate_updated",
    data: {
      debateId: session.id,
      status: session.status,
      currentRound: session.currentRound,
      currentStage: session.currentStage,
      updatedAt: session.updatedAt
    }
  });
}

export function emitProvidersUpdated(): void {
  broadcast({
    type: "providers_updated",
    data: {
      at: new Date().toISOString()
    }
  });
}

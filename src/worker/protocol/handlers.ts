import type { WorkerCommand } from "../../shared/contracts/protocol";
import type { ProjectService } from "../domain/project-service";
import type { RoomService } from "../domain/room-service";
import type { AnyCommandHandler, CommandHandler } from "./command-handler";

export interface CommandHandlerServices {
  projectService: ProjectService;
  roomService: RoomService;
  prepareQuit(deadlineMs: number): Promise<void>;
}

type CanonicalHandlers = {
  [TType in WorkerCommand["type"]]: CommandHandler<TType>;
};

export function createCommandHandlers(
  services: CommandHandlerServices
): readonly AnyCommandHandler[] {
  const handlers: CanonicalHandlers = {
    "state.getSnapshot": {
      type: "state.getSnapshot",
      handle: () => ({ data: services.roomService.getSnapshot(), replayed: false })
    },
    "room.replay": {
      type: "room.replay",
      handle: (command) => ({
        data: services.roomService.replayRoom(command.payload),
        replayed: false
      })
    },
    "project.addExisting": {
      type: "project.addExisting",
      handle: async (command, context) => {
        const result = await services.projectService.addExistingProject(
          command.payload,
          context.durable(command)
        );
        return { data: result.value, replayed: result.replayed };
      }
    },
    "room.create": {
      type: "room.create",
      handle: (command, context) => {
        const result = services.roomService.createRoom(command.payload, context.durable(command));
        return { data: result.value, replayed: result.replayed };
      }
    },
    "message.post": {
      type: "message.post",
      handle: (command, context) => {
        const result = services.roomService.postUserMessage(command.payload, context.durable(command));
        return { data: result.value, replayed: result.replayed };
      }
    },
    "worker.prepareQuit": {
      type: "worker.prepareQuit",
      handle: async (command) => {
        await services.prepareQuit(command.payload.deadlineMs);
        return { data: { prepared: true as const }, replayed: false };
      }
    }
  };

  return [
    handlers["state.getSnapshot"],
    handlers["room.replay"],
    handlers["project.addExisting"],
    handlers["room.create"],
    handlers["message.post"],
    handlers["worker.prepareQuit"]
  ];
}

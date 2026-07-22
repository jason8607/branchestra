import type { ProjectService } from "../domain/project-service";
import type { RoomService } from "../domain/room-service";
import type { AnyCommandHandler } from "./command-handler";

export interface CommandHandlerServices {
  projectService: ProjectService;
  roomService: RoomService;
  prepareQuit(deadlineMs: number): Promise<void>;
}

export function createCommandHandlers(
  services: CommandHandlerServices
): readonly AnyCommandHandler[] {
  return [
    {
      type: "state.getSnapshot",
      handle: () => ({ data: services.roomService.getSnapshot(), replayed: false })
    },
    {
      type: "room.replay",
      handle: (command) => ({
        data: services.roomService.replayRoom(command.payload),
        replayed: false
      })
    },
    {
      type: "project.addExisting",
      handle: async (command, context) => {
        const result = await services.projectService.addExistingProject(
          command.payload,
          context.durable(command)
        );
        return { data: result.value, replayed: result.replayed };
      }
    },
    {
      type: "room.create",
      handle: (command, context) => {
        const result = services.roomService.createRoom(command.payload, context.durable(command));
        return { data: result.value, replayed: result.replayed };
      }
    },
    {
      type: "message.post",
      handle: (command, context) => {
        const result = services.roomService.postUserMessage(command.payload, context.durable(command));
        return { data: result.value, replayed: result.replayed };
      }
    },
    {
      type: "worker.prepareQuit",
      handle: async (command) => {
        await services.prepareQuit(command.payload.deadlineMs);
        return { data: { prepared: true as const }, replayed: false };
      }
    }
  ] satisfies readonly AnyCommandHandler[];
}

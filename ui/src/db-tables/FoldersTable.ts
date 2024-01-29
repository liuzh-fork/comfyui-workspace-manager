import { deleteLocalDiskFolder } from "../Api";
import { workflowsTable } from "./WorkspaceDB";
import { EFlowOperationType, Folder } from "../types/dbTypes";
import { validateOrSaveAllJsonFileMyWorkflows } from "../utils";
import { v4 as uuidv4 } from "uuid";
import { TableBase } from "./TableBase";
import { indexdb } from "./indexdb";
import { generateFolderPath } from "./DiskFileUtils";

export class FoldersTable extends TableBase<Folder> {
  static readonly TABLE_NAME = "folders";

  constructor() {
    super("folders");
  }

  static async load(): Promise<FoldersTable> {
    const instance = new FoldersTable();
    return instance;
  }

  public async create(input: {
    name: string;
    parentFolderID?: string;
  }): Promise<Folder> {
    const uniqueName = await this.generateUniqueName(
      input.name,
      input.parentFolderID,
    );
    const folder: Folder = {
      id: uuidv4(),
      name: uniqueName,
      parentFolderID: input.parentFolderID ?? null,
      updateTime: Date.now(),
      createTime: Date.now(),
      type: "folder",
    };
    await indexdb.folders.add(folder);
    this.saveDiskDB();
    return folder;
  }

  public async update(
    input: {
      id: string;
    } & Partial<Folder>,
  ) {
    const folder = await this.get(input.id);
    if (folder == null) {
      return;
    }
    const newRecord = {
      ...folder,
      ...input,
    };
    if (input.name != null) {
      newRecord.updateTime = Date.now();
    }
    const allFolders = await this.listAll();
    const folderWithSameName = allFolders.find(
      (f) =>
        f.parentFolderID == newRecord.parentFolderID && // use == instead of ===, because parentFolderID can be null or undefined
        f.name === newRecord.name &&
        f.id !== newRecord.id,
    );
    if (folderWithSameName != null) {
      input.name = await this.generateUniqueName(
        newRecord.name,
        newRecord.parentFolderID ?? undefined,
      );
    }
    await indexdb.folders.update(input.id, input);
    this.saveDiskDB();

    // folder moved or renamed - move all workflows to the right directory(not required when folded state changes)
    if (
      input.name != folder.name ||
      input.parentFolderID != folder.parentFolderID
    ) {
      validateOrSaveAllJsonFileMyWorkflows(true);
    }
  }
  public async deleteFolder(
    id: string,
    flowOperationType: EFlowOperationType = EFlowOperationType.DELETE,
  ) {
    const folderPath = await generateFolderPath(id);

    /**
     * When deleting a folder, if there are files in the folder
     * Breadth traverse all nested folders, find all files, move to root directory or delete as needed.
     */
    const allFlows = (await workflowsTable?.listAll()) ?? [];
    const allFolders = await this.listAll();
    const nestedFolderIdStack = [id];

    while (nestedFolderIdStack.length > 0) {
      const curFolderId = nestedFolderIdStack.shift();

      if (curFolderId) {
        for (const flow of allFlows) {
          if (flow.parentFolderID === curFolderId) {
            switch (flowOperationType) {
              case EFlowOperationType.DELETE:
                await workflowsTable?.deleteFlow(flow.id);
                break;
              case EFlowOperationType.MOVE_TO_ROOT_FOLDER:
                await workflowsTable?.updateFlow(flow.id, {
                  parentFolderID: undefined,
                });
                break;
            }
          }
        }

        await indexdb.folders.delete(curFolderId);
        const curNestedFolderIds = allFolders
          .filter((f) => f.parentFolderID === curFolderId)
          .map((f) => f.id);

        if (curNestedFolderIds.length) {
          nestedFolderIdStack.push(...curNestedFolderIds);
        }
      }
    }

    folderPath && (await deleteLocalDiskFolder(folderPath));
    this.saveDiskDB();
  }

  public async generateUniqueName(name?: string, parentFolderID?: string) {
    let newFlowName = name ?? "New folder";
    const folderNameList = await this.listAll().then((list) =>
      list.filter((f) => f.parentFolderID == parentFolderID).map((f) => f.name),
    );
    if (folderNameList.includes(newFlowName)) {
      let num = 2;
      let flag = true;
      while (flag) {
        if (folderNameList.includes(`${newFlowName} ${num}`)) {
          num++;
        } else {
          newFlowName = `${newFlowName} ${num}`;
          flag = false;
        }
      }
    }
    return newFlowName;
  }
}



// import { __createBinding, __importStar, __awaiter, __importDefault } from 'tslib';
import validator from 'validator';
import user from '../user';
import meta from '../meta';
import messaging from '../messaging';
import plugins from '../plugins';
import socketHelpers from '../socket.io/helpers';


// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
const chatsAPI: { [key: string]: Function } = {};

interface SessionData {
    lastChatMessageTime?: number;
}

interface Caller {
    uid: number;
    request?: {
        session: SessionData;
    };
    session?: SessionData;
    ip?: string;
}

interface UsersResponse {
    users: Caller[]; 
}


interface Data {
    uids?: number[];
    roomId?: number;
    message?: string;
    name?: string;
}


// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call

function rateLimitExceeded(caller: Caller): boolean {
    const session = caller.request ? caller.request.session : caller.session; // socket vs req
    const now = Date.now();
    session.lastChatMessageTime = session.lastChatMessageTime || 0;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (now - session.lastChatMessageTime < meta.config.chatMessageDelay) {
        return true;
    }
    session.lastChatMessageTime = now;
    return false;
}

chatsAPI.create = async function (caller: Caller, data: Data) {
    if (rateLimitExceeded(caller)) {
        throw new Error('[[error:too-many-messages]]');
    }

    if (!data.uids || !Array.isArray(data.uids)) {
        throw new Error(`[[error:wrong-parameter-type, uids, ${typeof data.uids}, Array]]`);
    }

    await Promise.all(data.uids.map(async uid => messaging.canMessageUser(caller.uid, uid)));
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    const roomId = await messaging.newRoom(caller.uid, data.uids!);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    return await messaging.getRoomData(roomId);
};

chatsAPI.post = async (caller: Caller, data: Data) => {
    if (rateLimitExceeded(caller)) {
        throw new Error('[[error:too-many-messages]]');
    }

    ({ data } = await plugins.hooks.fire('filter:messaging.send', {
        data,
        uid: caller.uid,
    }) as { data: Data });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
    await messaging.canMessageRoom(caller.uid, data.roomId!);
    const message = await messaging.sendMessage({
        uid: caller.uid,
        roomId: data.roomId!,
        content: data.message!,
        timestamp: Date.now(),
        ip: caller.ip,
    });
    messaging.notifyUsersInRoom(caller.uid, data.roomId!, message);
    user.updateOnlineUsers(caller.uid);

    return message;
};

chatsAPI.rename = async (caller: Caller, data: Data) => {
    await messaging.renameRoom(caller.uid, data.roomId!, data.name!);
    const uids = await messaging.getUidsInRoom(data.roomId!, 0, -1);
    const eventData = { roomId: data.roomId!, newName: validator.escape(String(data.name)) };

    socketHelpers.emitToUids('event:chats.roomRename', eventData, uids);
    return messaging.loadRoom(caller.uid, {
        roomId: data.roomId!,
    });
};

chatsAPI.users = async (caller: Caller, data: Data) => {
    const [isOwner, users] = await Promise.all([
        messaging.isRoomOwner(caller.uid, data.roomId!),
        messaging.getUsersInRoom(data.roomId!, 0, -1),
    ]);

    users.forEach((user) => {
        
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call

        user.canKick = (parseInt(user.uid, 10) !== caller.uid) && isOwner;
    });

    return { users };
};

chatsAPI.invite = async (caller: Caller, data: Data) => {
    const userCount = await messaging.getUserCountInRoom(data.roomId!);
    const maxUsers = meta.config.maximumUsersInChatRoom;
    if (maxUsers && userCount >= maxUsers) {
        throw new Error('[[error:cant-add-more-users-to-chat-room]]');
    }

    const uidsExist = await user.exists(data.uids!);
    if (!uidsExist.every(Boolean)) {
        throw new Error('[[error:no-user]]');
    }

    await Promise.all(data.uids!.map(async uid => messaging.canMessageUser(caller.uid, uid)));
    await messaging.addUsersToRoom(caller.uid, data.uids!, data.roomId!);

    delete data.uids;
    return chatsAPI.users(caller, data);
};





chatsAPI.kick = async (caller: Caller, data: Data): Promise<UsersResponse> => {
    const uidsExist = await user.exists(data.uids);

    if (!uidsExist.every((val: any) => !!val)) {
        throw new Error('[[error:no-user]]');
    }

    const userIDsAsString = data.uids!.map(uid => uid.toString());

    if (userIDsAsString.length === 1 && userIDsAsString[0] === caller.uid.toString()) {
        await messaging.leaveRoom([caller.uid.toString()], data.roomId!);
    } else {
        await messaging.removeUsersFromRoom(caller.uid, userIDsAsString, data.roomId!);
    }

    delete data.uids;

    // Assuming `chatsAPI.users` returns an object of type UsersResponse
    const usersResponse = await chatsAPI.users(caller, data) as UsersResponse;
    return usersResponse;
};


export = chatsAPI;
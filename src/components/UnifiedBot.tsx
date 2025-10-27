import {
  Accessor,
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  mergeProps,
  onCleanup,
  onMount,
} from 'solid-js';
import { v4 as uuidv4 } from 'uuid';
import {
  BotMessageTheme,
  FooterTheme,
  TextInputTheme,
  UserMessageTheme,
  DisclaimerPopUpTheme,
  DateTimeToggleTheme,
} from '@/features/bubble/types';
import { Avatar } from '@/components/avatars/Avatar';
import { TextInput } from '@/components/inputs/textInput';
import { GuestBubble } from '@/components/bubbles/GuestBubble';
import { BotBubble } from '@/components/bubbles/BotBubble';
import { LoadingBubble } from '@/components/bubbles/LoadingBubble';
import { StarterPromptBubble } from '@/components/bubbles/StarterPromptBubble';
import { FollowUpPromptBubble } from '@/components/bubbles/FollowUpPromptBubble';
import { DeleteButton, SendButton } from '@/components/buttons/SendButton';
import { FilePreview } from '@/components/inputs/textInput/components/FilePreview';
import { CircleDotIcon, SparklesIcon, TrashIcon } from '@/components/icons';
import { CancelButton } from '@/components/buttons/CancelButton';
import { Popup, DisclaimerPopup } from '@/features/popup';
import { Badge } from '@/components/Badge';
import {
  MessageType,
  UploadsConfig,
  FileUpload,
  IAction,
  observersConfigType,
  LeadsConfig,
  BotProps,
} from './Bot';
import {
  ChatAttachment,
  ChatMessagePayload,
  ChatOrchestrator,
  ChatStreamEvent,
  OrchestratorOptions,
  ProviderDescriptor,
} from '@/sdk';
import { createAdapter } from '@/sdk';
import { getLocalStorageChatflow, removeLocalStorageChatHistory, setCookie, setLocalStorageChatflow, getCookie } from '@/utils';
import { cloneDeep } from 'lodash';

const defaultBackgroundColor = '#f7f8ff';
const defaultTextColor = '#303235';
const defaultTitleBackgroundColor = '#3B81F6';
const defaultTitleTextColor = '#ffffff';
const defaultWelcomeMessage = 'Hi there! How can I help?';

export type MultiProviderProps = BotProps & {
  providers: ProviderDescriptor[];
  orchestratorOptions?: OrchestratorOptions;
};

type InternalFilePreview = {
  data: string;
  type: string;
  name: string;
  mime: string;
  preview?: string;
};

const encodeAttachmentData = (data: string | ArrayBuffer): string | undefined => {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) {
    let binary = '';
    const bytes = new Uint8Array(data);
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return `data:application/octet-stream;base64,${btoa(binary)}`;
  }
  return undefined;
};

const toChatAttachments = (files: InternalFilePreview[]): ChatAttachment[] =>
  files.map((file) => ({
    name: file.name,
    mimeType: file.mime,
    data: file.data,
    metadata: { type: file.type },
  }));

const toFileUploads = (files: InternalFilePreview[]): Partial<FileUpload>[] =>
  files.map((file) => ({
    name: file.name,
    mime: file.mime,
    data: file.data,
    type: file.type,
  }));

const createInitialMessages = (welcomeMessage?: string) => [
  {
    message: welcomeMessage ?? defaultWelcomeMessage,
    type: 'apiMessage',
  } as MessageType,
];

const toVariables = (base: Record<string, unknown> | undefined, formData: Record<string, unknown>) => ({
  ...(base ?? {}),
  ...formData,
});

const getDestinationLabel = (descriptor: ProviderDescriptor, destinationId: string) =>
  descriptor.destinations.find((destination) => destination.id === destinationId)?.label ?? destinationId;

export const UnifiedBot = (rawProps: MultiProviderProps) => {
  const props = mergeProps({ showTitle: true }, rawProps);
  const [messages, setMessages] = createSignal<MessageType[]>(createInitialMessages(props.welcomeMessage));
  const [loading, setLoading] = createSignal(false);
  const [userInput, setUserInput] = createSignal('');
  const [previews, setPreviews] = createSignal<InternalFilePreview[]>([]);
  const [uploadedFiles, setUploadedFiles] = createSignal<File[]>([]);
  const [isDragActive, setIsDragActive] = createSignal(false);
  const [activeProviderId, setActiveProviderId] = createSignal<string>('');
  const [activeDestinationId, setActiveDestinationId] = createSignal<string>('');
  const [followUpPrompts, setFollowUpPrompts] = createSignal<string[]>([]);
  const [followUpPromptEnabled, setFollowUpPromptEnabled] = createSignal(true);
  const [chatId, setChatId] = createSignal<string>(uuidv4());
  const [orchestrator, setOrchestrator] = createSignal<ChatOrchestrator>();
  const [disclaimerPopupOpen, setDisclaimerPopupOpen] = createSignal(false);
  const [isRecording, setIsRecording] = createSignal(false);
  const [elapsedTime, setElapsedTime] = createSignal('00:00');
  const [isLoadingRecording, setIsLoadingRecording] = createSignal(false);
  const [errorMessage, setErrorMessage] = createSignal(props.errorMessage ?? 'I’m having trouble connecting. Please try again.');
  const [sourcePopupOpen, setSourcePopupOpen] = createSignal(false);
  const [sourcePopupSrc, setSourcePopupSrc] = createSignal('');
  const [startConfigLoaded, setStartConfigLoaded] = createSignal(false);

  let chatContainer: HTMLDivElement | undefined;
  let botContainer: HTMLDivElement | undefined;

  const providerMap = createMemo(() =>
    props.providers.reduce<Record<string, ProviderDescriptor>>((acc, descriptor) => {
      acc[descriptor.id] = descriptor;
      return acc;
    }, {})
  );

  const providerOptions = createMemo(() => props.providers);

  const activeProvider = createMemo(() => providerMap()[activeProviderId()]);
  const activeDestination = createMemo(() =>
    activeProvider()?.destinations.find((destination) => destination.id === activeDestinationId())
  );

  const chatStorageKey = createMemo(() => `${activeProviderId()}::${activeDestinationId()}::${props.orchestratorOptions?.sessionId ?? ''}`);

  const chatFeedbackStatus = createMemo(() => props.feedback?.status ?? false);
  const uploadsConfiguration = createMemo(() => props.textInput?.uploadsConfig as UploadsConfig | undefined);
  const ttsEnabled = () => false;
  const ttsLoading = () => ({} as Record<string, boolean>);
  const ttsPlaying = () => ({} as Record<string, boolean>);

  const persistMessages = (entries: MessageType[]) => {
    const sanitized = entries.map((item) => {
      if (item.fileUploads) {
        const fileUploads = item.fileUploads.map((file) => ({
          type: file.type,
          name: file.name,
          mime: file.mime,
        }));
        return { ...item, fileUploads } as MessageType;
      }
      return item;
    });
    setLocalStorageChatflow(chatStorageKey(), chatId(), { chatHistory: sanitized });
  };

  const initializeOrchestrator = () => {
    if (!props.providers.length) return;
    const adapterFactory = (descriptor: ProviderDescriptor) => createAdapter(descriptor);
    const orchestratorInstance = new ChatOrchestrator(props.providers, adapterFactory, props.orchestratorOptions);
    const provider = orchestratorInstance.getActiveProvider();
    const destination = orchestratorInstance.getActiveDestination();
    setActiveProviderId(provider.id);
    if (destination) setActiveDestinationId(destination.id);
    setOrchestrator(orchestratorInstance);
  };

  const resetChatForProvider = () => {
    removeLocalStorageChatHistory(chatStorageKey());
    const welcome = props.welcomeMessage ?? defaultWelcomeMessage;
    setMessages(createInitialMessages(welcome));
    setChatId(uuidv4());
  };

  const loadProviderSession = () => {
    const chatMessage = getLocalStorageChatflow(chatStorageKey());
    if (!chatMessage || !Object.keys(chatMessage).length) {
      resetChatForProvider();
      return;
    }
    const loadedMessages: MessageType[] =
      chatMessage?.chatHistory?.length > 0
        ? chatMessage.chatHistory.map((message: MessageType) => ({ ...message }))
        : createInitialMessages(props.welcomeMessage);
    setMessages(loadedMessages);
    if (chatMessage.chatId) setChatId(chatMessage.chatId);
  };

  onMount(() => {
    initializeOrchestrator();
    loadProviderSession();
  });

  createEffect(() => {
    const orchestratorInstance = orchestrator();
    if (!orchestratorInstance || !props.providers.length || startConfigLoaded()) return;
    setStartConfigLoaded(true);
    const session = getLocalStorageChatflow(chatStorageKey());
    if (session?.chatId) setChatId(session.chatId);
  });

  createEffect(() => {
    if (!props.disclaimer) {
      setDisclaimerPopupOpen(false);
      return;
    }
    if (getCookie('chatbotDisclaimer') === 'true') {
      setDisclaimerPopupOpen(false);
    } else {
      setDisclaimerPopupOpen(true);
    }
  });

  createEffect(() => {
    setFollowUpPromptEnabled(true);
  });

  const handleProviderChange = async (providerId: string) => {
    const orchestratorInstance = orchestrator();
    if (!orchestratorInstance) return;
    const descriptor = providerMap()[providerId];
    if (!descriptor) return;
    const destination = descriptor.destinations[0];
    setActiveProviderId(providerId);
    setActiveDestinationId(destination?.id ?? '');
    await orchestratorInstance.setActive(providerId, destination.id);
    loadProviderSession();
  };

  const handleDestinationChange = async (destinationId: string) => {
    const orchestratorInstance = orchestrator();
    if (!orchestratorInstance) return;
    if (!activeProvider()) return;
    setActiveDestinationId(destinationId);
    await orchestratorInstance.setActive(activeProviderId(), destinationId);
    loadProviderSession();
  };

  const scrollToBottom = () => {
    setTimeout(() => {
      if (chatContainer) chatContainer.scrollTo(0, chatContainer.scrollHeight);
    }, 100);
  };

  const handleError = (message: string, isError = false) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      if (isError) {
        allMessages.push({ message, type: 'apiMessage' });
      } else {
        const lastMessage = allMessages[allMessages.length - 1];
        if (lastMessage && lastMessage.type === 'apiMessage') {
          lastMessage.message = message;
        } else {
          allMessages.push({ message, type: 'apiMessage' });
        }
      }
      persistMessages(allMessages);
      return allMessages;
    });
  };

  const updateLastMessage = (text: string) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.message += text;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateMetadata = (data: any, input: string) => {
    if (data?.chatId) {
      setChatId(data.chatId);
    }
    if (input === '' && data?.question) {
      setMessages((prev) => {
        const allMessages = [...cloneDeep(prev)];
        if (allMessages[allMessages.length - 2]?.type === 'apiMessage') return allMessages;
        allMessages[allMessages.length - 2].message = data.question;
        persistMessages(allMessages);
        return allMessages;
      });
    }
    if (data?.followUpPrompts) {
      setFollowUpPrompts(JSON.parse(data.followUpPrompts));
      setMessages((prev) => {
        const allMessages = [...cloneDeep(prev)];
        if (allMessages[allMessages.length - 1].type === 'userMessage') return allMessages;
        allMessages[allMessages.length - 1].followUpPrompts = data.followUpPrompts;
        persistMessages(allMessages);
        return allMessages;
      });
    }
  };

  const updateLastMessageSourceDocuments = (sourceDocs: any) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.sourceDocuments = sourceDocs;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateLastMessageUsedTools = (tools: any) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.usedTools = tools;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateLastMessageFileAnnotations = (annotations: any) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.fileAnnotations = annotations;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateLastMessageAgentReasoning = (reasoning: any) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.agentReasoning = reasoning;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateAgentFlowEvent = (eventData: any) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.agentFlowEventStatus = eventData.status;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateAgentFlowExecutedData = (data: any) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.agentFlowExecutedData = data;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateLastMessageAction = (action: IAction) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.action = action;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateLastMessageArtifacts = (artifacts: any) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.artifacts = artifacts;
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const updateErrorMessage = (payload: any) => {
    setMessages((prev) => {
      const allMessages = [...prev];
      const lastIndex = allMessages.length - 1;
      if (lastIndex < 0) return allMessages;
      const lastMessage = allMessages[lastIndex];
      if (lastMessage.type === 'apiMessage') {
        lastMessage.message = payload?.message || errorMessage();
        persistMessages(allMessages);
      }
      return allMessages;
    });
  };

  const abortMessage = () => {
    setMessages((prev) => {
      const allMessages = [...cloneDeep(prev)];
      const lastMessage = allMessages[allMessages.length - 1];
      if (lastMessage?.agentReasoning?.length) {
        lastMessage.agentReasoning = lastMessage.agentReasoning.filter((reasoning: any) => !reasoning.nextAgent);
      }
      return allMessages;
    });
  };

  const closeResponse = () => {
    setLoading(false);
    setUserInput('');
    setUploadedFiles([]);
    setTimeout(scrollToBottom, 100);
  };

  const processStreamEvent = (event: ChatStreamEvent, input: string) => {
    switch (event.kind) {
      case 'lifecycle':
        if (event.phase === 'start') {
          setMessages((prev) => [...prev, { message: '', type: 'apiMessage' }]);
        }
        if (event.phase === 'complete') {
          closeResponse();
          persistMessages(messages());
        }
        break;
      case 'chunk':
        updateLastMessage(event.value);
        break;
      case 'metadata':
        switch (event.channel) {
          case 'metadata':
            updateMetadata(event.data, input);
            break;
          case 'sourceDocuments':
            updateLastMessageSourceDocuments(event.data);
            break;
          case 'usedTools':
            updateLastMessageUsedTools(event.data);
            break;
          case 'fileAnnotations':
            updateLastMessageFileAnnotations(event.data);
            break;
          case 'agentReasoning':
            updateLastMessageAgentReasoning(event.data);
            break;
          case 'agentFlowEvent':
            updateAgentFlowEvent(event.data);
            break;
          case 'agentFlowExecutedData':
            updateAgentFlowExecutedData(event.data);
            break;
          case 'action':
            updateLastMessageAction(event.data as IAction);
            break;
          case 'artifacts':
            updateLastMessageArtifacts(event.data);
            break;
          case 'abort':
            abortMessage();
            closeResponse();
            break;
          case 'end':
            closeResponse();
            break;
          default:
            break;
        }
        break;
      case 'error':
        updateErrorMessage({ message: event.error.message });
        closeResponse();
        break;
    }
  };

  const isAsyncGenerator = <T,>(value: any): value is AsyncGenerator<T> =>
    value && typeof value[Symbol.asyncIterator] === 'function';

  const handleStream = async (
    response: AsyncGenerator<ChatStreamEvent> | { message?: string; metadata?: Record<string, unknown>; raw?: unknown },
    input: string
  ) => {
    if (isAsyncGenerator<ChatStreamEvent>(response)) {
      for await (const event of response) {
        processStreamEvent(event, input);
      }
    } else {
      const result = response;
      setMessages((prev) => {
        const allMessages = [...prev, { message: result.message ?? '', type: 'apiMessage' }];
        persistMessages(allMessages);
        return allMessages;
      });
      closeResponse();
    }
  };

  const clearPreviews = () => {
    setPreviews([]);
    setUploadedFiles([]);
  };

  const handleFileUploads = async (uploads: InternalFilePreview[]) => uploads;

  const handleSubmit = async (value: string | object, action?: IAction | null, humanInput?: Record<string, unknown>) => {
    if (typeof value === 'string' && value.trim() === '' && previews().length === 0) return;
    const orchestratorInstance = orchestrator();
    if (!orchestratorInstance) return;

    let formData: Record<string, unknown> = {};
    let textValue = value;
    if (typeof value === 'object') {
      formData = value;
      textValue = Object.entries(value)
        .map(([key, val]) => `${key}: ${val}`)
        .join('\n');
    }

    setLoading(true);
    scrollToBottom();

    let uploads = previews().map((item) => ({
      data: item.data,
      type: item.type,
      name: item.name,
      mime: item.mime,
    }));

    uploads = await handleFileUploads(uploads as InternalFilePreview[]);
    clearPreviews();

    setMessages((prev) => {
      const nextMessages: MessageType[] = [
        ...prev,
        { message: textValue as string, type: 'userMessage', fileUploads: toFileUploads(uploads) },
      ];
      persistMessages(nextMessages);
      return nextMessages;
    });

    const variables = toVariables(props.chatflowConfig?.vars as Record<string, unknown> | undefined, formData);
    if (humanInput) variables.humanInput = humanInput;
    if (action) variables.action = action;

    const payload: ChatMessagePayload = {
      message: typeof textValue === 'string' ? textValue : undefined,
      files: toChatAttachments(uploads as InternalFilePreview[]),
      variables: Object.keys(variables).length ? variables : undefined,
      toolInvocation: action?.mapping?.toolCalls?.length
        ? { name: 'multi-tool', arguments: { toolCalls: action.mapping.toolCalls } }
        : undefined,
    };

    try {
      const response = await orchestratorInstance.sendMessage(payload);
      await handleStream(response, typeof textValue === 'string' ? textValue : '');
    } catch (error) {
      handleError(error instanceof Error ? error.message : errorMessage(), true);
      closeResponse();
    }
  };

  const previewDisplay = (item: InternalFilePreview) => {
    if (item.mime.startsWith('image/')) {
      return (
        <button class="group w-12 h-12 flex items-center justify-center relative rounded-[10px] overflow-hidden" onClick={() => handleDeletePreview(item)}>
          <img class="w-full h-full bg-cover" src={item.data} />
          <span class="absolute hidden group-hover:flex items-center justify-center z-10 w-full h-full top-0 left-0 bg-black/10 rounded-[10px]">
            <TrashIcon />
          </span>
        </button>
      );
    }
    if (item.mime.startsWith('audio/')) {
      return (
        <div class="inline-flex basis-auto flex-grow-0 flex-shrink-0 justify-between items-center rounded-xl h-12 p-1 mr-1 bg-gray-500">
          <audio class="block bg-cover bg-center w-full h-full rounded-none text-transparent" controls src={item.data} />
          <button class="w-7 h-7 flex items-center justify-center bg-transparent p-1" onClick={() => handleDeletePreview(item)}>
            <TrashIcon color="white" />
          </button>
        </div>
      );
    }
    return <FilePreview disabled={loading()} item={{ name: item.name }} onDelete={() => handleDeletePreview(item)} />;
  };

  const handleDeletePreview = (item: InternalFilePreview) => {
    setPreviews(previews().filter((preview) => preview !== item));
  };

  const handleDisclaimerAccept = () => {
    setDisclaimerPopupOpen(false);
    setCookie('chatbotDisclaimer', 'true', 365);
  };

  const handleDrag = (event: DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.type === 'dragenter' || event.type === 'dragover') setIsDragActive(true);
    if (event.type === 'dragleave') setIsDragActive(false);
  };

  const handleDrop = async (event: DragEvent) => {
    event.preventDefault();
    setIsDragActive(false);
    if (!event.dataTransfer) return;
    const files: InternalFilePreview[] = [];
    const uploaded: File[] = [];
    for (const file of Array.from(event.dataTransfer.files)) {
      uploaded.push(file);
      const reader = new FileReader();
      const preview = await new Promise<InternalFilePreview>((resolve) => {
        reader.onload = (evt) => {
          if (!evt?.target?.result) return;
          const result = evt.target.result as string;
          resolve({ data: result, preview: result, type: 'file', name: file.name, mime: file.type });
        };
        reader.readAsDataURL(file);
      });
      files.push(preview);
    }
    setUploadedFiles(uploaded);
    setPreviews((prev) => [...prev, ...files]);
  };

  const onFormSubmit = (formData: Record<string, unknown>) => {
    handleSubmit(formData);
  };

  const onPromptClick = (prompt: string) => {
    handleSubmit(prompt);
  };

  const onFollowUpClick = (prompt: string) => {
    setFollowUpPrompts([]);
    handleSubmit(prompt);
  };

  const onDisclaimerDeny = () => {
    setDisclaimerPopupOpen(false);
    setMessages([{ message: 'Disclaimer declined', type: 'apiMessage' } as MessageType]);
  };

  const renderProviderSelector = () => (
    <div class="flex flex-col gap-2 p-3 border-b border-[#eeeeee] bg-white">
      <div class="flex gap-2 items-center">
        <span class="text-xs uppercase tracking-wide text-gray-500">Provider</span>
        <select
          class="flex-1 border border-[#d6d6d6] rounded-md px-2 py-1 text-sm"
          value={activeProviderId()}
          onChange={(event) => handleProviderChange(event.currentTarget.value)}
        >
          <For each={providerOptions()}>
            {(provider) => (
              <option value={provider.id}>{provider.label}</option>
            )}
          </For>
        </select>
      </div>
      <Show when={activeProvider()}>
        <div class="flex gap-2 items-center">
          <span class="text-xs uppercase tracking-wide text-gray-500">Destination</span>
          <select
            class="flex-1 border border-[#d6d6d6] rounded-md px-2 py-1 text-sm"
            value={activeDestinationId()}
            onChange={(event) => handleDestinationChange(event.currentTarget.value)}
          >
            <For each={activeProvider()?.destinations ?? []}>
              {(destination) => (
                <option value={destination.id}>{destination.label}</option>
              )}
            </For>
          </select>
        </div>
      </Show>
    </div>
  );

  onCleanup(() => {
    setMessages(createInitialMessages(props.welcomeMessage));
  });

  return (
    <div class="relative flex w-full h-full text-base overflow-hidden bg-cover bg-center flex-col items-center chatbot-container">
      <Show when={props.showTitle}>
        <div
          class="flex flex-row items-center w-full h-[50px]"
          style={{
            background: props.titleBackgroundColor || defaultTitleBackgroundColor,
            color: props.titleTextColor || defaultTitleTextColor,
            'border-top-left-radius': props.isFullPage ? '0px' : '6px',
            'border-top-right-radius': props.isFullPage ? '0px' : '6px',
          }}
        >
          <Show when={props.titleAvatarSrc}>
            <div style={{ width: '15px' }} />
            <Avatar initialAvatarSrc={props.titleAvatarSrc} />
          </Show>
          <Show when={props.title}>
            <span class="px-3 whitespace-pre-wrap font-semibold max-w-full">{props.title}</span>
          </Show>
          <div style={{ flex: 1 }} />
          <Badge textColor={props.poweredByTextColor} />
        </div>
      </Show>
      <Show when={props.disclaimer && disclaimerPopupOpen()}>
        <DisclaimerPopup
          title={props.disclaimer?.title ?? ''}
          message={props.disclaimer?.message ?? ''}
          textColor={props.disclaimer?.textColor ?? defaultTextColor}
          buttonColor={props.disclaimer?.buttonColor ?? defaultTitleBackgroundColor}
          buttonText={props.disclaimer?.buttonText ?? 'Start Chatting'}
          buttonTextColor={props.disclaimer?.buttonTextColor ?? defaultTitleTextColor}
          denyButtonText={props.disclaimer?.denyButtonText ?? 'Cancel'}
          denyButtonBgColor={props.disclaimer?.denyButtonBgColor ?? '#ef4444'}
          blurredBackgroundColor={props.disclaimer?.blurredBackgroundColor ?? 'rgba(0,0,0,0.4)'}
          onAccept={handleDisclaimerAccept}
          onDeny={onDisclaimerDeny}
        />
      </Show>
      {renderProviderSelector()}
      <div class="flex flex-col w-full h-full justify-start">
        <div ref={chatContainer} class="overflow-y-scroll flex flex-col flex-grow min-w-full w-full px-3 pt-4 scrollable-container chatbot-chat-view">
          <For each={messages()}>
            {(message, index) => (
              <>
                {message.type === 'userMessage' && (
                  <GuestBubble
                    message={message}
                    apiHost={activeProvider()?.config?.apiHost as string}
                    chatflowid={activeDestinationId()}
                    chatId={chatId()}
                    backgroundColor={props.userMessage?.backgroundColor}
                    textColor={props.userMessage?.textColor}
                    showAvatar={props.userMessage?.showAvatar}
                    avatarSrc={props.userMessage?.avatarSrc}
                    fontSize={props.fontSize}
                    renderHTML={props.renderHTML}
                  />
                )}
                {message.type === 'apiMessage' && (
                  <BotBubble
                    message={message}
                    fileAnnotations={message.fileAnnotations}
                    chatflowid={activeDestinationId()}
                    chatId={chatId()}
                    apiHost={activeProvider()?.config?.apiHost as string}
                    backgroundColor={props.botMessage?.backgroundColor}
                    textColor={props.botMessage?.textColor}
                    feedbackColor={props.feedback?.color}
                    showAvatar={props.botMessage?.showAvatar}
                    avatarSrc={props.botMessage?.avatarSrc}
                    chatFeedbackStatus={chatFeedbackStatus()}
                    fontSize={props.fontSize}
                    isLoading={loading() && index() === messages().length - 1}
                    showAgentMessages={props.showAgentMessages}
                    handleActionClick={(elem, act) => handleSubmit(elem.label, act)}
                    sourceDocsTitle={props.sourceDocsTitle}
                    handleSourceDocumentsClick={(src) => {
                      setSourcePopupSrc(src);
                      setSourcePopupOpen(true);
                    }}
                    dateTimeToggle={props.dateTimeToggle as DateTimeToggleTheme}
                    renderHTML={props.renderHTML}
                    isTTSEnabled={ttsEnabled()}
                    isTTSLoading={ttsLoading()}
                    isTTSPlaying={ttsPlaying()}
                  />
                )}
                {message.type === 'userMessage' && loading() && index() === messages().length - 1 && <LoadingBubble />}
              </>
            )}
          </For>
        </div>
        <Show when={messages().length === 1 && (props.starterPrompts?.length ?? 0) > 0}>
          <div class="w-full flex flex-row flex-wrap px-5 py-[10px] gap-2">
            <For each={Array.isArray(props.starterPrompts) ? props.starterPrompts : Object.values(props.starterPrompts ?? {})}>
              {(prompt: any) => (
                <StarterPromptBubble prompt={typeof prompt === 'string' ? prompt : prompt.prompt} onPromptClick={() => onPromptClick(typeof prompt === 'string' ? prompt : prompt.prompt)} starterPromptFontSize={props.starterPromptFontSize} />
              )}
            </For>
          </div>
        </Show>
        <Show when={messages().length > 2 && followUpPromptEnabled() && followUpPrompts().length > 0}>
          <div class="flex items-center gap-1 px-5">
            <SparklesIcon class="w-4 h-4" />
            <span class="text-sm text-gray-700">Try these prompts</span>
          </div>
          <div class="w-full flex flex-row flex-wrap px-5 py-[10px] gap-2">
            <For each={followUpPrompts()}>{(prompt) => <FollowUpPromptBubble prompt={prompt} onPromptClick={() => onFollowUpClick(prompt)} starterPromptFontSize={props.starterPromptFontSize} />}</For>
          </div>
        </Show>
        <Show when={previews().length > 0}>
          <div class="w-full flex items-center justify-start gap-2 px-5 pt-2 border-t border-[#eeeeee]">
            <For each={previews()}>{(item) => <>{previewDisplay(item)}</>}</For>
          </div>
        </Show>
        <div class="w-full px-5 pt-2 pb-1">
          <Show when={isRecording()}>
            <div class="h-[58px] flex items-center justify-between chatbot-input border border-[#eeeeee]" data-testid="input">
              <div class="flex items-center gap-3 px-4 py-2">
                <span>
                  <CircleDotIcon color="red" />
                </span>
                <span>{elapsedTime() || '00:00'}</span>
                {isLoadingRecording() && <span class="ml-1.5">Sending...</span>}
              </div>
              <div class="flex items-center">
                <CancelButton buttonColor={props.textInput?.sendButtonColor} type="button" class="m-0" on:click={() => setIsRecording(false)}>
                  <span style={{ 'font-family': 'Poppins, sans-serif' }}>Send</span>
                </CancelButton>
                <SendButton sendButtonColor={props.textInput?.sendButtonColor} type="button" isDisabled={loading()} class="m-0" on:click={() => setIsRecording(false)}>
                  <span style={{ 'font-family': 'Poppins, sans-serif' }}>Send</span>
                </SendButton>
              </div>
            </div>
          </Show>
          <Show when={!isRecording()}>
            <TextInput
              backgroundColor={props.textInput?.backgroundColor}
              textColor={props.textInput?.textColor}
              placeholder={props.textInput?.placeholder}
              sendButtonColor={props.textInput?.sendButtonColor}
              inputValue={userInput()}
              onInputChange={(value) => setUserInput(value)}
              onSubmit={(value) => handleSubmit(value)}
              uploadsConfig={uploadsConfiguration()}
              isFullFileUpload={false}
              setPreviews={setPreviews as unknown as (value: any) => void}
              onMicrophoneClicked={() => setIsRecording(true)}
              handleFileChange={(event) => {
                const files = event.target.files;
                if (!files) return;
                const result: InternalFilePreview[] = [];
                const uploaded: File[] = [];
                const readers: Promise<void>[] = [];
                for (const file of Array.from(files)) {
                  uploaded.push(file);
                  const reader = new FileReader();
                  readers.push(
                    new Promise((resolve) => {
                      reader.onload = (evt) => {
                        if (!evt?.target?.result) return resolve();
                        result.push({ data: evt.target.result as string, type: 'file', name: file.name, mime: file.type });
                        resolve();
                      };
                      reader.readAsDataURL(file);
                    })
                  );
                }
                Promise.all(readers).then(() => {
                  setUploadedFiles(uploaded);
                  setPreviews((prev) => [...prev, ...result]);
                });
              }}
              disabled={loading()}
              fontSize={props.fontSize}
              sendMessageSound={props.textInput?.sendMessageSound}
              sendSoundLocation={props.textInput?.sendSoundLocation}
              enableInputHistory={props.textInput?.enableInputHistory}
              maxHistorySize={props.textInput?.maxHistorySize}
            />
          </Show>
        </div>
        <Show when={props.footer}>
          <div class="w-full flex items-center justify-center pb-4">
            <Popup footer={props.footer as FooterTheme} />
          </div>
        </Show>
      </div>
      <Show when={sourcePopupOpen()}>
        <Popup
          open={sourcePopupOpen()}
          onClose={() => setSourcePopupOpen(false)}
          title={props.sourceDocsTitle ?? 'Sources'}
          content={sourcePopupSrc()}
          backgroundColor={props.botMessage?.backgroundColor}
          textColor={props.botMessage?.textColor}
        />
      </Show>
    </div>
  );
};

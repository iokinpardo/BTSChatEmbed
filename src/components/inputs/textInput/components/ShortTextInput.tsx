import { createEffect, createSignal, splitProps } from 'solid-js';
import { JSX } from 'solid-js/jsx-runtime';

type ShortTextInputProps = {
  ref: HTMLInputElement | HTMLTextAreaElement | undefined;
  onInput: (value: string) => void;
  fontSize?: number;
  disabled?: boolean;
} & Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, 'onInput'>;

const DEFAULT_HEIGHT = 56;
const MAX_HEIGHT = 128;

const clampHeight = (value: number) => Math.min(Math.max(value, DEFAULT_HEIGHT), MAX_HEIGHT);

export const ShortTextInput = (props: ShortTextInputProps) => {
  const [local, others] = splitProps(props, ['ref', 'onInput']);
  const [height, setHeight] = createSignal(56);

  const resizeToContent = (element: HTMLTextAreaElement) => {
    element.style.height = 'auto';
    setHeight(clampHeight(element.scrollHeight));
  };

  // @ts-expect-error: unknown type
  const handleInput = (e) => {
    if (props.ref) {
      if (e.currentTarget.value === '') {
        setHeight(DEFAULT_HEIGHT);
      } else {
        resizeToContent(e.currentTarget);
      }
      e.currentTarget.scrollTo(0, e.currentTarget.scrollHeight);
      local.onInput(e.currentTarget.value);
    }
  };

  // @ts-expect-error: unknown type
  const handleKeyDown = (e) => {
    // Handle Shift + Enter new line
    if (e.keyCode == 13 && e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.value += '\n';
      handleInput(e);
    }
  };

  createEffect(() => {
    const target = props.ref as HTMLTextAreaElement | undefined;

    if (!target) return;

    if (props.value === '') {
      setHeight(DEFAULT_HEIGHT);
      target.style.height = `${DEFAULT_HEIGHT}px`;
      target.scrollTop = 0;
      return;
    }

    resizeToContent(target);
  });

  return (
    <textarea
      ref={props.ref}
      class="focus:outline-none bg-transparent px-4 py-4 flex-1 w-full h-full min-h-[56px] max-h-[128px] text-input disabled:opacity-50 disabled:cursor-not-allowed disabled:brightness-100 "
      disabled={props.disabled}
      style={{
        'font-size': props.fontSize ? `${props.fontSize}px` : '16px',
        resize: 'none',
        height: `${props.value !== '' ? height() : DEFAULT_HEIGHT}px`,
      }}
      onInput={handleInput}
      onKeyDown={handleKeyDown}
      {...others}
    />
  );
};

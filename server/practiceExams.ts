import type {
  AnswerOptionKey,
  AttemptDetailedAnswer,
  ExamQuestion,
  StudentAnswerInput,
} from '../src/types.ts'

export interface ServerPracticeQuestion extends ExamQuestion {
  correctIndex: number
  explanation: string
}

export interface ServerPracticeExam {
  id: string
  title: string
  topicGroup: string
  durationMinutes: number
  level: string
  description: string
  questions: ServerPracticeQuestion[]
}

export const SERVER_PRACTICE_EXAMS: ServerPracticeExam[] = [
  {
    id: 'exam-general-12',
    title: 'Đề luyện tập mẫu tổng hợp Tin học 12',
    topicGroup: 'Tổng hợp kiến thức trọng tâm',
    durationMinutes: 10,
    level: 'Cơ bản · Thông hiểu',
    description:
      'Gồm 5 câu hỏi trắc nghiệm mẫu thuộc các chuyên đề AI, Mạng máy tính, HTML/CSS và Cơ sở dữ liệu.',
    questions: [
      {
        id: 'q1',
        topic: 'Mạng máy tính',
        prompt:
          'Thiết bị nào sau đây có chức năng định tuyến gói tin giữa các mạng khác nhau trên Internet?',
        options: ['Switch (Bộ chuyển mạch)', 'Router (Bộ định tuyến)', 'Repeater (Bộ lặp)', 'Hub'],
        correctIndex: 1,
        explanation:
          'Router hoạt động ở tầng mạng, đọc địa chỉ IP để xác định đường đi tối ưu cho gói tin giữa các mạng khác nhau.',
      },
      {
        id: 'q2',
        topic: 'HTML5',
        prompt: 'Trong HTML, thẻ nào được sử dụng để tạo một siêu liên kết tới trang web khác?',
        options: ['<link>', '<a>', '<href>', '<nav>'],
        correctIndex: 1,
        explanation:
          'Thẻ <a> kết hợp với thuộc tính href dùng để tạo liên kết điều hướng trong HTML.',
      },
      {
        id: 'q3',
        topic: 'CSS3',
        prompt: 'Thuộc tính CSS nào giúp thay đổi màu nền của một phần tử HTML?',
        options: ['color', 'background-color', 'border-color', 'font-color'],
        correctIndex: 1,
        explanation:
          'background-color quy định màu nền của phần tử, trong khi color quy định màu chữ.',
      },
      {
        id: 'q4',
        topic: 'Trí tuệ nhân tạo',
        prompt:
          'Ví dụ nào sau đây thể hiện ứng dụng của Trí tuệ nhân tạo (AI) trong thực tế?',
        options: [
          'Soạn thảo văn bản bằng bảng mã Unicode',
          'Hệ thống nhận dạng khuôn mặt và gợi ý nội dung học tập cá nhân hóa',
          'Lưu trữ tệp tin trên ổ cứng SSD',
          'Chuyển đổi định dạng ảnh từ PNG sang JPG',
        ],
        correctIndex: 1,
        explanation:
          'Nhận dạng hình ảnh và phân tích hành vi để cá nhân hóa là các bài toán điển hình của Học máy và AI.',
      },
      {
        id: 'q5',
        topic: 'Cơ sở dữ liệu',
        prompt:
          'Trong mô hình cơ sở dữ liệu quan hệ, khóa chính (Primary Key) có đặc điểm nào sau đây?',
        options: [
          'Có thể chứa giá trị trùng lặp nhưng không được để trống',
          'Xác định duy nhất mỗi bản ghi trong bảng và không nhận giá trị NULL',
          'Chỉ dùng để lưu trữ dữ liệu kiểu văn bản',
          'Luôn phải là cột cuối cùng trong bảng',
        ],
        correctIndex: 1,
        explanation:
          'Khóa chính đảm bảo tính duy nhất cho từng bản ghi trong bảng và bắt buộc không được để trống (NOT NULL).',
      },
    ],
  },
  {
    id: 'exam-web-12',
    title: 'Chuyên đề Thiết kế trang web (HTML & CSS)',
    topicGroup: 'Chủ đề F · Tạo trang web',
    durationMinutes: 10,
    level: 'Thông hiểu · Vận dụng',
    description:
      'Gồm 4 câu hỏi mẫu kiểm tra kiến thức về cấu trúc tài liệu HTML, biểu mẫu và bộ chọn CSS.',
    questions: [
      {
        id: 'w1',
        topic: 'HTML Biểu mẫu',
        prompt:
          'Thuộc tính nào của thẻ <input> bắt buộc người dùng phải nhập dữ liệu trước khi gửi biểu mẫu?',
        options: ['placeholder', 'required', 'readonly', 'checked'],
        correctIndex: 1,
        explanation:
          'Thuộc tính required buộc trình duyệt kiểm tra trường dữ liệu không được để trống khi submit form.',
      },
      {
        id: 'w2',
        topic: 'Bộ chọn CSS',
        prompt:
          'Trong CSS, ký hiệu nào đứng trước tên lớp (class) khi khai báo quy tắc định dạng?',
        options: ['Dấu thăng (#)', 'Dấu chấm (.)', 'Dấu sao (*)', 'Dấu hai chấm (:)'],
        correctIndex: 1,
        explanation:
          'Bộ chọn lớp (class selector) bắt đầu bằng dấu chấm (.), còn bộ chọn định danh (id) bắt đầu bằng dấu thăng (#).',
      },
      {
        id: 'w3',
        topic: 'Bảng HTML',
        prompt: 'Thẻ HTML nào dùng để định nghĩa một ô tiêu đề trong bảng?',
        options: ['<td>', '<tr>', '<th>', '<thead>'],
        correctIndex: 2,
        explanation:
          '<th> (table header cell) tạo ô tiêu đề, mặc định được in đậm và căn giữa.',
      },
      {
        id: 'w4',
        topic: 'CSS Box Model',
        prompt:
          'Trong mô hình hộp CSS (Box Model), khoảng cách nằm giữa nội dung (content) và đường viền (border) là gì?',
        options: ['margin', 'padding', 'outline', 'gap'],
        correctIndex: 1,
        explanation:
          'padding là vùng đệm bên trong giữa nội dung và viền; margin là khoảng cách bên ngoài viền.',
      },
    ],
  },
  {
    id: 'exam-network-12',
    title: 'Chuyên đề Mạng máy tính & An toàn thông tin',
    topicGroup: 'Chủ đề A & B · Mạng & AI',
    durationMinutes: 8,
    level: 'Cơ bản · Vận dụng',
    description:
      'Gồm 4 câu hỏi mẫu về giao thức mạng, địa chỉ IP và nguyên tắc giao tiếp an toàn trên không gian mạng.',
    questions: [
      {
        id: 'n1',
        topic: 'Giao thức mạng',
        prompt:
          'Giao thức nào đảm bảo truyền dữ liệu web an toàn nhờ cơ chế mã hóa giữa trình duyệt và máy chủ?',
        options: ['HTTP', 'HTTPS', 'FTP', 'SMTP'],
        correctIndex: 1,
        explanation:
          'HTTPS (HTTP Secure) sử dụng giao thức TLS/SSL để mã hóa dữ liệu trao đổi, bảo vệ thông tin trước nguy cơ nghe lén.',
      },
      {
        id: 'n2',
        topic: 'Địa chỉ mạng',
        prompt:
          'Hệ thống nào giúp chuyển đổi tên miền dễ nhớ (ví dụ: tinlab.edu.vn) sang địa chỉ IP tương ứng?',
        options: ['DHCP', 'DNS', 'TCP', 'MAC'],
        correctIndex: 1,
        explanation:
          'DNS (Domain Name System) làm nhiệm vụ phân giải tên miền thành địa chỉ IP.',
      },
      {
        id: 'n3',
        topic: 'Kết nối không dây',
        prompt:
          'Thiết bị nào giúp mở rộng vùng phủ sóng hoặc phát Wi-Fi cho các thiết bị di động kết nối vào mạng LAN?',
        options: ['Access Point (Điểm truy cập không dây)', 'CPU', 'RAM', 'Card âm thanh'],
        correctIndex: 0,
        explanation:
          'Access Point (AP) tạo mạng không dây WLAN và kết nối các thiết bị Wi-Fi vào mạng có dây.',
      },
      {
        id: 'n4',
        topic: 'An toàn thông tin',
        prompt:
          'Biện pháp nào sau đây giúp tăng cường bảo mật tài khoản học tập trực tuyến hiệu quả nhất?',
        options: [
          'Sử dụng cùng một mật khẩu đơn giản cho mọi tài khoản',
          'Đặt mật khẩu mạnh kết hợp xác thực hai yếu tố (2FA)',
          'Chia sẻ mật khẩu qua tin nhắn công khai',
          'Lưu mật khẩu trên máy tính công cộng ở phòng thực hành',
        ],
        correctIndex: 1,
        explanation:
          'Mật khẩu mạnh kết hợp xác thực hai yếu tố (2FA) giảm thiểu đáng kể nguy cơ bị chiếm quyền truy cập.',
      },
    ],
  },
]

const OPTION_KEYS: AnswerOptionKey[] = ['A', 'B', 'C', 'D']

function roundScore(val: number): number {
  return Math.round(val * 100) / 100
}

export function getServerPracticeExamById(examId: string): ServerPracticeExam | null {
  return SERVER_PRACTICE_EXAMS.find((exam) => exam.id === examId) ?? null
}

export function gradePracticeExamAttempt(params: {
  exam: ServerPracticeExam
  studentAnswers: StudentAnswerInput[]
}) {
  const answerByQuestionId = new Map<string, StudentAnswerInput>()
  for (const item of params.studentAnswers) {
    if (item && typeof item.questionId === 'string') {
      answerByQuestionId.set(item.questionId, item)
    }
  }

  const totalQuestions = params.exam.questions.length
  const pointsPerQuestion = roundScore(10 / Math.max(1, totalQuestions))
  let correctCount = 0

  const detailedAnswers: AttemptDetailedAnswer[] = params.exam.questions.map((q) => {
    const submitted = answerByQuestionId.get(q.id)
    const selectedOption = submitted?.selectedOption ?? null
    const selectedIndex =
      selectedOption && OPTION_KEYS.includes(selectedOption)
        ? OPTION_KEYS.indexOf(selectedOption)
        : -1
    const correctOption = OPTION_KEYS[q.correctIndex] ?? 'A'
    const isCorrect = selectedIndex === q.correctIndex
    if (isCorrect) {
      correctCount += 1
    }

    return {
      questionId: q.id,
      part: 1,
      questionType: 'multiple_choice',
      questionText: q.prompt,
      topic: q.topic,
      maxPoints: pointsPerQuestion,
      earnedPoints: isCorrect ? pointsPerQuestion : 0,
      selectedOption,
      correctOption,
      selectedOptionText:
        selectedIndex >= 0 && q.options[selectedIndex] ? q.options[selectedIndex] : '',
      correctOptionText: q.options[q.correctIndex] ?? '',
      explanation: q.explanation,
    }
  })

  const finalScore = roundScore((correctCount / Math.max(1, totalQuestions)) * 10)

  return {
    part1Score: finalScore,
    part1Max: 10,
    part2Score: 0,
    part2Max: 0,
    part3Score: 0,
    part3Max: 0,
    score: finalScore,
    maxScore: 10,
    correctCount,
    totalQuestions,
    completionStatus: 'auto_graded' as const,
    scoringMode: 'practice_10',
    detailedAnswers,
  }
}
